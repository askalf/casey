import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseTicket,
  newTicket,
  addTurn,
  conversationText,
  saveTicket,
  loadTickets,
  findOpenByConversation,
} from "./ticket.js";
import { triageSchema } from "./triage.js";
import { troubleshootSchema } from "./troubleshoot.js";
import { extractJson } from "./llm.js";
import { createHmac } from "node:crypto";
import { emailConversationId } from "./channels/email.js";
import { WebChannel } from "./channels/web.js";
import { SlackChannel } from "./channels/slack.js";
import { TeamsChannel } from "./channels/teams.js";
import { DiscordChannel } from "./channels/discord.js";
import { SmsChannel } from "./channels/sms.js";
import { VoiceChannel } from "./channels/voice.js";
import { verifyTwilio, formParams } from "./channels/twilio-common.js";
import { registerConsole } from "./console.js";
import type { ChannelServer, ServerRequest, ServerResponse, InboundMessage } from "./channels/types.js";

interface Case {
  name: string;
  pass: boolean;
  detail?: string;
}
const cases: Case[] = [];
const check = (name: string, pass: boolean, detail?: string): void => {
  cases.push({ name, pass, detail });
};

function parseTests(): void {
  const j = parseTicket('{"from":"a@b.com","subject":"VPN down","body":"cannot connect"}');
  check("parse: JSON ticket", j.from === "a@b.com" && j.subject === "VPN down" && j.body === "cannot connect", JSON.stringify(j));

  const e = parseTicket("From: jane@acme.com\nSubject: printer jammed\n\nThe printer on the 3rd floor won't print.");
  check(
    "parse: plain email headers + body",
    e.from === "jane@acme.com" && e.subject === "printer jammed" && /3rd floor/.test(e.body),
    JSON.stringify(e),
  );

  const b = parseTicket("My laptop won't turn on at all.");
  check("parse: body-only fallback", b.subject === "(no subject)" && /laptop/.test(b.body), JSON.stringify(b));
}

function schemaTests(): void {
  const ok = triageSchema.safeParse({
    category: "network",
    priority: "P2",
    tier: 3,
    summary: "VPN won't connect",
    missing_info: [],
    action: "escalate",
    client_reply: "We're on it.",
    escalation_brief: "diagnose VPN",
  });
  check("schema: valid triage parses", ok.success, ok.success ? undefined : JSON.stringify(ok.error.issues));

  const bad = triageSchema.safeParse({
    category: "nope",
    priority: "P9",
    tier: 5,
    summary: "x",
    missing_info: [],
    action: "explode",
    client_reply: "",
  });
  check("schema: invalid triage rejected", !bad.success, bad.success ? "should have failed" : undefined);

  const ts = troubleshootSchema.safeParse({
    status: "troubleshooting",
    client_reply: "Can you tell me what error you see?",
    internal_note: "need the exact error",
  });
  check("schema: valid troubleshoot parses", ts.success, ts.success ? undefined : JSON.stringify(ts.error.issues));

  const tsBad = troubleshootSchema.safeParse({ status: "giveup", client_reply: "" });
  check("schema: invalid troubleshoot rejected", !tsBad.success, tsBad.success ? "should have failed" : undefined);
}

function extractJsonTests(): void {
  const bare = extractJson('{"a":1}') as { a?: number } | null;
  check("extractJson: bare object", bare?.a === 1);

  const fenced = extractJson('```json\n{"a":2}\n```') as { a?: number } | null;
  check("extractJson: fenced object", fenced?.a === 2);

  const prose = extractJson('Sure, here you go:\n{"a":3}\nHope that helps!') as { a?: number } | null;
  check("extractJson: object embedded in prose", prose?.a === 3);

  check("extractJson: no json → null", extractJson("there is no json here") === null);
}

function ticketTests(): void {
  const t = newTicket({ channel: "web", conversationId: "web:abc", from: "u@x.com", subject: "help", body: "it broke" });
  check(
    "ticket: newTicket seeds the thread",
    t.status === "new" && t.thread.length === 1 && t.thread[0].role === "client" && t.thread[0].text === "it broke" && t.channel === "web",
    JSON.stringify({ status: t.status, len: t.thread.length }),
  );

  addTurn(t, "casey", "what error do you see?");
  check("ticket: addTurn appends + updates", t.thread.length === 2 && t.thread[1].role === "casey");

  const convo = conversationText(t);
  check("ticket: conversationText renders roles", /^CLIENT: it broke/.test(convo) && /CASEY: what error/.test(convo), convo);
}

function emailConvTests(): void {
  const a = emailConversationId("Jane@Acme.com", "Re: Printer jammed");
  const b = emailConversationId("jane@acme.com", "Printer jammed");
  check("email: conversationId ignores Re:/case", a === b, `${a} vs ${b}`);
  check("email: different subjects differ", emailConversationId("j@a.com", "VPN") !== emailConversationId("j@a.com", "Email"));
}

async function storeTests(): Promise<void> {
  const store = path.join(os.tmpdir(), `casey-test-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}.jsonl`);
  try {
    const t = newTicket({ channel: "web", conversationId: "web:conv1", from: "u@x.com", subject: "help", body: "broken" });
    await saveTicket(store, t);
    t.status = "troubleshooting";
    addTurn(t, "casey", "step 1");
    await saveTicket(store, t); // same id, second write

    const loaded = await loadTickets(store);
    check("store: dedupes by id, last write wins", loaded.length === 1 && loaded[0].status === "troubleshooting", `len=${loaded.length}`);

    const open = await findOpenByConversation(store, "web:conv1");
    check("store: findOpenByConversation finds the open ticket", open?.id === t.id);

    t.status = "resolved";
    await saveTicket(store, t);
    const closed = await findOpenByConversation(store, "web:conv1");
    check("store: resolved ticket is no longer open", closed === null);
  } finally {
    await fsp.rm(store, { force: true }).catch(() => {});
  }
}

class MockServer implements ChannelServer {
  routes = new Map<string, (req: ServerRequest) => Promise<ServerResponse>>();
  route(method: "GET" | "POST", p: string, handler: (req: ServerRequest) => Promise<ServerResponse>): void {
    this.routes.set(`${method} ${p}`, handler);
  }
}

function mkReq(body: string): ServerRequest {
  return { method: "POST", path: "/web", query: {}, headers: {}, body };
}

async function webChannelTests(): Promise<void> {
  const web = new WebChannel();
  const server = new MockServer();
  web.register(server, async (msg) => ({ channel: msg.channel, conversationId: msg.conversationId, to: msg.from, text: `echo:${msg.text}` }));

  check("web: registers widget + endpoints", server.routes.has("GET /") && server.routes.has("POST /web") && server.routes.has("POST /webhook"));

  const post = server.routes.get("POST /web")!;
  const ok = await post(mkReq(JSON.stringify({ conversationId: "web:x", from: "u@x.com", text: "help me" })));
  const okBody = JSON.parse(ok.body) as { conversationId?: string; reply?: string; status?: string };
  check("web: POST /web returns the reply synchronously", ok.status === 200 && okBody.reply === "echo:help me" && okBody.conversationId === "web:x", ok.body);

  const noText = await post(mkReq(JSON.stringify({ from: "u@x.com" })));
  check("web: missing text → 400", noText.status === 400);

  const badJson = await post(mkReq("{not json"));
  check("web: invalid JSON → 400", badJson.status === 400);
}

function signSlack(secret: string, ts: string, body: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
}

async function slackTests(): Promise<void> {
  const secret = "shhh-signing-secret";
  const slack = new SlackChannel("xoxb-test", secret);
  const server = new MockServer();
  const got: InboundMessage[] = [];
  slack.register(server, async (m) => {
    got.push(m);
    return null;
  });
  check("slack: registers events endpoint", server.routes.has("POST /slack/events"));
  const post = server.routes.get("POST /slack/events")!;
  const ts = String(Math.floor(Date.now() / 1000));

  const challengeBody = JSON.stringify({ type: "url_verification", challenge: "ch-123" });
  const ch = await post({
    method: "POST", path: "/slack/events", query: {},
    headers: { "x-slack-request-timestamp": ts, "x-slack-signature": signSlack(secret, ts, challengeBody) },
    body: challengeBody,
  });
  check("slack: url_verification echoes challenge", ch.status === 200 && JSON.parse(ch.body).challenge === "ch-123", ch.body);

  const evBody = JSON.stringify({
    type: "event_callback", event_id: "Ev1",
    event: { type: "message", user: "U1", channel: "C1", ts: "1700.1", text: "my vpn is down" },
  });
  const ev = await post({
    method: "POST", path: "/slack/events", query: {},
    headers: { "x-slack-request-timestamp": ts, "x-slack-signature": signSlack(secret, ts, evBody) },
    body: evBody,
  });
  const sm = got[0];
  check(
    "slack: signed message event acked + parsed",
    ev.status === 200 && got.length === 1 && sm?.channel === "slack" && sm?.conversationId === "slack:C1:1700.1" && sm?.text === "my vpn is down",
    JSON.stringify(sm ?? null),
  );

  const bad = await post({
    method: "POST", path: "/slack/events", query: {},
    headers: { "x-slack-request-timestamp": ts, "x-slack-signature": "v0=deadbeef" },
    body: evBody,
  });
  check("slack: bad signature → 401", bad.status === 401);
}

async function teamsTests(): Promise<void> {
  const teams = new TeamsChannel("app-id", "app-pass");
  const server = new MockServer();
  const got: InboundMessage[] = [];
  teams.register(server, async (m) => {
    got.push(m);
    return null;
  });
  check("teams: registers messages endpoint", server.routes.has("POST /teams/messages"));
  const post = server.routes.get("POST /teams/messages")!;
  const body = JSON.stringify({
    type: "message", text: "printer offline", id: "act1",
    from: { id: "u9", name: "Dana" }, conversation: { id: "19:meeting_abc" },
    serviceUrl: "https://smba.trafficmanager.net/",
  });
  const res = await post({ method: "POST", path: "/teams/messages", query: {}, headers: {}, body });
  const tm = got[0];
  check(
    "teams: activity acked + parsed",
    res.status === 200 && got.length === 1 && tm?.channel === "teams" && tm?.conversationId === "teams:19:meeting_abc" && tm?.from === "u9" && tm?.meta?.serviceUrl === "https://smba.trafficmanager.net/",
    JSON.stringify(tm ?? null),
  );
}

function discordTests(): void {
  const d = new DiscordChannel("bot-token");
  check("discord: constructs as a connection channel", d.name === "discord" && d.kind === "connection");
}

function signTwilio(token: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}

function twilioCommonTests(): void {
  const token = "tw-token";
  const url = "https://x.test/sms";
  const params = { From: "+1999", Body: "hello" };
  check("twilio: valid signature verifies", verifyTwilio(token, url, params, signTwilio(token, url, params)));
  check("twilio: wrong signature rejected", !verifyTwilio(token, url, params, "bogus"));
  check("twilio: formParams parses urlencoded", formParams("From=%2B1999&Body=hi").Body === "hi");
}

async function smsTests(): Promise<void> {
  const token = "tw-token";
  const base = "https://x.test";
  const sms = new SmsChannel("ACxxx", token, "+15550001111", base);
  const server = new MockServer();
  const got: InboundMessage[] = [];
  sms.register(server, async (m) => {
    got.push(m);
    return null;
  });
  check("sms: registers /sms", server.routes.has("POST /sms"));
  const post = server.routes.get("POST /sms")!;
  const params = { From: "+15559998888", Body: "my laptop won't boot" };
  const body = new URLSearchParams(params).toString();
  const ok = await post({
    method: "POST", path: "/sms", query: {},
    headers: { "x-twilio-signature": signTwilio(token, base + "/sms", params) },
    body,
  });
  const m = got[0];
  check(
    "sms: signed message acked (TwiML) + parsed",
    ok.status === 200 && (ok.headers?.["content-type"] || "").includes("xml") && got.length === 1 && m?.channel === "sms" && m?.conversationId === "sms:+15559998888" && m?.text === "my laptop won't boot",
    JSON.stringify(m ?? null),
  );
  const bad = await post({ method: "POST", path: "/sms", query: {}, headers: { "x-twilio-signature": "nope" }, body });
  check("sms: bad signature → 403", bad.status === 403);
}

async function voiceTests(): Promise<void> {
  const token = "tw-token";
  const base = "https://x.test";
  const voice = new VoiceChannel(token, base);
  const server = new MockServer();
  voice.register(server, async (m) => ({ channel: m.channel, conversationId: m.conversationId, to: m.from, text: "Please try restarting it." }));
  check("voice: registers /voice + /voice/gather", server.routes.has("POST /voice") && server.routes.has("POST /voice/gather"));

  const callParams = { CallSid: "CA1", From: "+1777" };
  const call = await server.routes.get("POST /voice")!({
    method: "POST", path: "/voice", query: {},
    headers: { "x-twilio-signature": signTwilio(token, base + "/voice", callParams) },
    body: new URLSearchParams(callParams).toString(),
  });
  check("voice: inbound call gathers speech", call.status === 200 && call.body.includes("<Gather") && call.body.includes("describe your issue"), call.body.slice(0, 80));

  const gp = { CallSid: "CA1", From: "+1777", SpeechResult: "my email is broken" };
  const g = await server.routes.get("POST /voice/gather")!({
    method: "POST", path: "/voice/gather", query: {},
    headers: { "x-twilio-signature": signTwilio(token, base + "/voice/gather", gp) },
    body: new URLSearchParams(gp).toString(),
  });
  check("voice: speech result spoken back via TwiML", g.status === 200 && g.body.includes("Please try restarting it.") && g.body.includes("<Gather"), g.body.slice(0, 120));

  const bad = await server.routes.get("POST /voice/gather")!({
    method: "POST", path: "/voice/gather", query: {},
    headers: { "x-twilio-signature": "nope" },
    body: new URLSearchParams(gp).toString(),
  });
  check("voice: bad signature → 403", bad.status === 403);
}

async function consoleTests(): Promise<void> {
  const store = path.join(os.tmpdir(), `casey-console-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}.jsonl`);
  const queue = path.join(os.tmpdir(), `casey-console-q-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`);
  const get = (p: string, query: Record<string, string> = {}): ServerRequest => ({ method: "GET", path: p, query, headers: {}, body: "" });
  const post = (p: string, body: unknown): ServerRequest => ({ method: "POST", path: p, query: {}, headers: {}, body: JSON.stringify(body) });
  try {
    const a = newTicket({ channel: "web", conversationId: "web:a", from: "u@x.com", subject: "printer down", body: "the printer is dead" });
    a.status = "resolved";
    await saveTicket(store, a);
    const b = newTicket({ channel: "web", conversationId: "web:b", from: "it@x.com", subject: "vpn outage", body: "vpn down for everyone" });
    b.status = "escalated";
    b.tier = 3;
    b.triage = { category: "network", priority: "P1", tier: 3, summary: "site-wide vpn outage", missing_info: [], action: "escalate", client_reply: "on it", escalation_brief: "investigate the ASA headend" };
    await saveTicket(store, b);

    const server = new MockServer();
    registerConsole(server, { ticketStore: store, arnieQueue: queue, darioUrl: undefined });

    check(
      "console: registers page + api routes",
      server.routes.has("GET /console") && server.routes.has("GET /api/tickets") && server.routes.has("GET /api/ticket") &&
        server.routes.has("GET /api/health") && server.routes.has("GET /api/activity") && server.routes.has("POST /api/ticket/close") &&
        server.routes.has("POST /api/ticket/reopen") && server.routes.has("POST /api/ticket/redispatch") &&
        server.routes.has("POST /api/ticket/reply"),
    );

    const page = await server.routes.get("GET /console")!(get("/console"));
    check("console: serves HTML page", page.status === 200 && page.body.includes("Casey Console") && (page.headers?.["content-type"] || "").includes("text/html"));

    const listRes = await server.routes.get("GET /api/tickets")!(get("/api/tickets"));
    const list = JSON.parse(listRes.body) as { tickets: Array<{ id: string; status: string; tier: number | null; priority: string | null }> };
    check("console: /api/tickets lists tickets", listRes.status === 200 && list.tickets.length === 2 && list.tickets.some((t) => t.id === b.id && t.tier === 3 && t.priority === "P1"), `len=${list.tickets.length}`);

    const detRes = await server.routes.get("GET /api/ticket")!(get("/api/ticket", { id: b.id }));
    const det = JSON.parse(detRes.body) as { ticket: { id: string; triage?: { escalation_brief?: string } }; arnie: { state: string } };
    check("console: /api/ticket returns detail + arnie state", detRes.status === 200 && det.ticket.id === b.id && det.ticket.triage?.escalation_brief === "investigate the ASA headend" && det.arnie.state === "none", det.arnie?.state);

    const missing = await server.routes.get("GET /api/ticket")!(get("/api/ticket"));
    check("console: /api/ticket without id → 400", missing.status === 400);

    const closed = await server.routes.get("POST /api/ticket/close")!(post("/api/ticket/close", { id: a.id }));
    const afterClose = (await loadTickets(store)).find((t) => t.id === a.id);
    check("console: close sets status closed", closed.status === 200 && afterClose?.status === "closed", afterClose?.status);

    const reopened = await server.routes.get("POST /api/ticket/reopen")!(post("/api/ticket/reopen", { id: a.id }));
    const afterReopen = (await loadTickets(store)).find((t) => t.id === a.id);
    check("console: reopen sets an open status", reopened.status === 200 && afterReopen?.status === "awaiting_client", afterReopen?.status);

    const redo = await server.routes.get("POST /api/ticket/redispatch")!(post("/api/ticket/redispatch", { id: b.id }));
    const taskFile = path.join(queue, "inbox", b.id + ".task");
    const taskBody = await fsp.readFile(taskFile, "utf8").catch(() => "");
    check("console: redispatch writes the arnie task file", redo.status === 200 && taskBody.includes("investigate the ASA headend") && taskBody.includes(b.id), taskBody.slice(0, 40));

    const rep = await server.routes.get("POST /api/ticket/reply")!(post("/api/ticket/reply", { id: a.id, text: "We pushed a fix, please retry." }));
    const repBody = JSON.parse(rep.body) as { ok: boolean; delivered: boolean };
    const afterReply = (await loadTickets(store)).find((t) => t.id === a.id);
    const last = afterReply?.thread[afterReply.thread.length - 1];
    check("console: reply appends a casey turn (web = record-only)", rep.status === 200 && repBody.ok === true && repBody.delivered === false && last?.role === "casey" && last?.text.includes("pushed a fix"), JSON.stringify({ role: last?.role }));

    const emptyReply = await server.routes.get("POST /api/ticket/reply")!(post("/api/ticket/reply", { id: a.id, text: "   " }));
    check("console: empty reply → 400", emptyReply.status === 400);

    const healthRes = await server.routes.get("GET /api/health")!(get("/api/health"));
    const h = JSON.parse(healthRes.body) as { casey: { state: string }; tickets: { total: number }; arnie: { state: string } };
    check("console: /api/health reports casey up + counts", healthRes.status === 200 && h.casey.state === "up" && h.tickets.total === 2 && typeof h.arnie.state === "string", JSON.stringify({ total: h.tickets?.total }));

    const actRes = await server.routes.get("GET /api/activity")!(get("/api/activity"));
    const act = JSON.parse(actRes.body) as { events: Array<{ kind: string; ticketId: string; status?: string }> };
    check(
      "console: /api/activity builds an event timeline",
      actRes.status === 200 && act.events.length > 0 && act.events.some((e) => e.kind === "new") &&
        act.events.some((e) => e.kind === "status" && e.status === "escalated"),
      `events=${act.events.length}`,
    );
  } finally {
    await fsp.rm(store, { force: true }).catch(() => {});
    await fsp.rm(queue, { recursive: true, force: true }).catch(() => {});
  }
}

async function main(): Promise<void> {
  parseTests();
  schemaTests();
  extractJsonTests();
  ticketTests();
  emailConvTests();
  await storeTests();
  await webChannelTests();
  await slackTests();
  await teamsTests();
  discordTests();
  twilioCommonTests();
  await smsTests();
  await voiceTests();
  await consoleTests();

  console.log("\n" + "=".repeat(60));
  console.log("CASEY TESTS");
  console.log("=".repeat(60));
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    console.log(`[${c.pass ? "PASS" : "FAIL"}] ${c.name}${c.detail ? " — " + c.detail : ""}`);
    if (c.pass) passed++;
    else failed++;
  }
  console.log(`\n${passed} passed, ${failed} failed (${cases.length} total)`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(1);
});
