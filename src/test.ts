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
