import fsp from "node:fs/promises";
import path from "node:path";

import { loadTickets, saveTicket, addTurn, type Ticket } from "./ticket.js";
import { loadClients, saveClient, newClient, newAsset, type Client } from "./clients.js";
import type { ChannelServer, ServerRequest, ServerResponse } from "./channels/types.js";

/**
 * The operator console — a single-pane web UI (sidebar + detail) served at
 * /console, with a User view (the live chat) and an Admin/Dev view (every
 * ticket, its thread + triage, arnie's outcome/report, stack health, and
 * full-control actions). It reads the same artifacts casey already writes
 * (tickets.jsonl, arnie's <queue>/inbox/*.outcome.json + reports) so there's
 * no new datastore — just a window onto the running service desk.
 */
export interface ConsoleCtx {
  ticketStore: string;
  /** Client + asset registry (JSONL). */
  clientStore: string;
  /** arnie hand-off queue root (tasks live in <queue>/inbox, outcomes alongside). */
  arnieQueue?: string;
  /** dario / LLM base URL, probed for the health panel. */
  darioUrl?: string;
  /** Deliver an operator reply out through the ticket's origin channel (no-op for web). */
  deliver?: (ticket: Ticket, text: string) => Promise<void>;
}

function json(status: number, body: unknown): ServerResponse {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function parseBody(req: ServerRequest): Record<string, unknown> {
  try {
    return JSON.parse(req.body || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

// Priority → SLA targets (wall-clock ms): [response, resolution]. Business-hours
// nuance is deferred; these are sane managed-services defaults.
const SLA_TARGETS: Record<string, { resp: number; res: number }> = {
  P1: { resp: 15 * 60000, res: 4 * 3600000 },
  P2: { resp: 60 * 60000, res: 8 * 3600000 },
  P3: { resp: 4 * 3600000, res: 24 * 3600000 },
  P4: { resp: 8 * 3600000, res: 48 * 3600000 },
};

/** SLA posture for a ticket, computed from created/priority/first-response/status. */
function computeSla(t: Ticket): { state: string; dueMs: number | null } {
  const tgt = SLA_TARGETS[t.triage?.priority ?? "P3"] ?? SLA_TARGETS.P3;
  const created = Date.parse(t.created_at) || Date.now();
  const open = t.status !== "resolved" && t.status !== "closed";
  if (!open) {
    const resolvedAt = Date.parse(t.updated_at) || Date.now();
    return { state: resolvedAt - created <= tgt.res ? "met" : "missed", dueMs: null };
  }
  const dueMs = tgt.res - (Date.now() - created);
  let state = "ok";
  if (dueMs < 0) state = "breached";
  else if (dueMs < tgt.res * 0.25) state = "at_risk";
  // Unanswered past the response target is at least at-risk.
  const firstCasey = (t.thread ?? []).find((x) => x.role === "casey");
  if (!firstCasey && Date.now() - created > tgt.resp && state === "ok") state = "at_risk";
  return { state, dueMs };
}

/** Compact ticket shape for the list (no full thread). */
function summarize(t: Ticket): Record<string, unknown> {
  return {
    id: t.id,
    created_at: t.created_at,
    updated_at: t.updated_at,
    channel: t.channel,
    from: t.from,
    subject: t.subject,
    status: t.status,
    tier: t.tier ?? t.triage?.tier ?? null,
    priority: t.triage?.priority ?? null,
    category: t.triage?.category ?? null,
    action: t.triage?.action ?? null,
    turns: t.thread?.length ?? 0,
    approval: t.approval ?? null,
    clientId: t.clientId ?? null,
    assetId: t.assetId ?? null,
    assignee: t.assignee ?? null,
    sla: computeSla(t),
  };
}

interface ArnieOutcome {
  task?: string;
  status?: string;
  report_path?: string;
  audit_path?: string;
  finished_at?: string;
}

/** Where a ticket stands in arnie's queue, plus the report text if it finished. */
async function arnieState(ctx: ConsoleCtx, id: string): Promise<Record<string, unknown>> {
  if (!ctx.arnieQueue) return { state: "n/a" };
  const inbox = path.join(ctx.arnieQueue, "inbox");
  const taskPath = path.join(inbox, id + ".task");
  const donePath = path.join(inbox, "done", id + ".task");
  const outcomePath = path.join(inbox, id + ".outcome.json");

  const outcome = await readJson<ArnieOutcome>(outcomePath);
  let state = "none";
  if (outcome) state = "done";
  else if (await fileExists(taskPath)) state = "pending";
  else if (await fileExists(donePath)) state = "working";

  let reportText: string | null = null;
  let reportPath: string | null = null;
  let auditPath: string | null = null;
  if (outcome) {
    reportPath = outcome.report_path ?? null;
    auditPath = outcome.audit_path ?? null;
    if (reportPath) reportText = await fsp.readFile(reportPath, "utf8").catch(() => null);
  }
  return { state, outcome, reportText, reportPath, auditPath };
}

async function probe(url: string): Promise<{ state: string; detail?: string }> {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(to);
    return { state: "up", detail: "HTTP " + res.status };
  } catch (e) {
    return { state: "down", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Stack health: casey (self), dario (probe), arnie (derived from the queue backlog). */
async function health(ctx: ConsoleCtx): Promise<Record<string, unknown>> {
  let dario: { state: string; detail?: string } = { state: "n/a" };
  if (ctx.darioUrl) dario = await probe(ctx.darioUrl);

  let arnie: Record<string, unknown> = { state: "n/a", pending: 0, oldestAgeMs: 0 };
  if (ctx.arnieQueue) {
    const inbox = path.join(ctx.arnieQueue, "inbox");
    const entries = await fsp.readdir(inbox).catch(() => [] as string[]);
    const tasks = entries.filter((e) => e.endsWith(".task"));
    const now = Date.now();
    let oldest = 0;
    for (const f of tasks) {
      const st = await fsp.stat(path.join(inbox, f)).catch(() => null);
      if (st) oldest = Math.max(oldest, now - st.mtimeMs);
    }
    // Pending tasks aging past a poll-or-two means arnie probably isn't draining.
    const state = tasks.length === 0 ? "idle" : oldest > 60000 ? "stalled" : "working";
    arnie = { state, pending: tasks.length, oldestAgeMs: Math.round(oldest) };
  }

  const tickets = await loadTickets(ctx.ticketStore);
  const todayStr = new Date().toISOString().slice(0, 10);
  const byStatus: Record<string, number> = {};
  let todayCount = 0;
  for (const t of tickets) {
    if (t.created_at.slice(0, 10) === todayStr) todayCount++;
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  }
  return {
    casey: { state: "up" },
    dario,
    arnie,
    tickets: { total: tickets.length, today: todayCount, byStatus },
  };
}

async function findTicket(ctx: ConsoleCtx, id: string): Promise<Ticket | undefined> {
  return (await loadTickets(ctx.ticketStore)).find((t) => t.id === id);
}

async function mutateStatus(ctx: ConsoleCtx, req: ServerRequest, status: Ticket["status"]): Promise<ServerResponse> {
  const id = String(parseBody(req).id ?? "");
  if (!id) return json(400, { error: "missing id" });
  const t = await findTicket(ctx, id);
  if (!t) return json(404, { error: "not found" });
  t.status = status;
  t.updated_at = new Date().toISOString();
  await saveTicket(ctx.ticketStore, t);
  return json(200, { ok: true, ticket: summarize(t) });
}

/** Re-write the arnie task file so a stuck/closed escalation gets picked up again. */
async function redispatch(ctx: ConsoleCtx, req: ServerRequest): Promise<ServerResponse> {
  const id = String(parseBody(req).id ?? "");
  if (!id) return json(400, { error: "missing id" });
  if (!ctx.arnieQueue) return json(400, { error: "no arnie queue configured" });
  const t = await findTicket(ctx, id);
  if (!t) return json(404, { error: "not found" });
  const brief = t.triage?.escalation_brief || t.triage?.summary || t.subject;
  const inbox = path.join(ctx.arnieQueue, "inbox");
  await fsp.mkdir(inbox, { recursive: true }).catch(() => {});
  const file = path.join(inbox, id + ".task");
  const task = "[escalated by Casey — ticket " + id + ", " + t.channel + " " + t.from + "]\n\n" + brief;
  await fsp.writeFile(file, task, "utf8");
  t.status = "escalated";
  t.routed_to = file;
  t.updated_at = new Date().toISOString();
  await saveTicket(ctx.ticketStore, t);
  return json(200, { ok: true, routed_to: file });
}

/**
 * T3 / discipline sign-off on an escalated remediation. Records the decision on
 * the ticket AND drops a <id>.decision.json into arnie's queue — the contract
 * arnie will read to execute-on-approval or stand down (the execute side lands
 * as its own change; this writes the decision regardless so it's ready).
 */
async function decide(ctx: ConsoleCtx, req: ServerRequest, decision: "approved" | "rejected"): Promise<ServerResponse> {
  const body = parseBody(req);
  const id = String(body.id ?? "");
  if (!id) return json(400, { error: "missing id" });
  const t = await findTicket(ctx, id);
  if (!t) return json(404, { error: "not found" });
  const by = body.by != null ? String(body.by) : "console";
  const note = body.note != null ? String(body.note) : undefined;
  const at = new Date().toISOString();
  t.approval = { decision, by, at, note };
  t.updated_at = at;
  await saveTicket(ctx.ticketStore, t);
  if (ctx.arnieQueue) {
    const inbox = path.join(ctx.arnieQueue, "inbox");
    await fsp.mkdir(inbox, { recursive: true }).catch(() => {});
    await fsp.writeFile(path.join(inbox, id + ".decision.json"), JSON.stringify({ ticketId: id, decision, by, at, note }, null, 2), "utf8");
  }
  return json(200, { ok: true, approval: t.approval });
}

/** Operator joins the thread as Casey. Records the turn; delivers it for push channels. */
async function reply(ctx: ConsoleCtx, req: ServerRequest): Promise<ServerResponse> {
  const body = parseBody(req);
  const id = String(body.id ?? "");
  const text = String(body.text ?? "");
  if (!id || !text.trim()) return json(400, { error: "missing id or text" });
  const t = await findTicket(ctx, id);
  if (!t) return json(404, { error: "not found" });
  addTurn(t, "casey", text);
  await saveTicket(ctx.ticketStore, t);

  // web/webhook/cli are synchronous (no outbound push) — record-only is the honest result.
  const pushless = t.channel === "web" || t.channel === "webhook" || t.channel === "cli";
  let delivered = false;
  let note = pushless
    ? "recorded — " + t.channel + " has no push channel; the client sees it when they next message this conversation"
    : "recorded";
  if (ctx.deliver && !pushless) {
    try {
      await ctx.deliver(t, text);
      delivered = true;
      note = "delivered via " + t.channel;
    } catch (e) {
      note = "recorded; delivery failed: " + (e instanceof Error ? e.message : String(e));
    }
  }
  return json(200, { ok: true, delivered, note, ticket: summarize(t) });
}

/** Assign (or clear) the staff member owning a ticket. */
async function assignTicket(ctx: ConsoleCtx, req: ServerRequest): Promise<ServerResponse> {
  const body = parseBody(req);
  const id = String(body.id ?? "");
  if (!id) return json(400, { error: "missing id" });
  const t = await findTicket(ctx, id);
  if (!t) return json(404, { error: "not found" });
  const who = String(body.assignee ?? "").trim();
  t.assignee = who || undefined;
  t.updated_at = new Date().toISOString();
  await saveTicket(ctx.ticketStore, t);
  return json(200, { ok: true, assignee: t.assignee ?? null });
}

/** Attach (or clear) a client + asset on a ticket. */
async function setTicketClient(ctx: ConsoleCtx, req: ServerRequest): Promise<ServerResponse> {
  const body = parseBody(req);
  const id = String(body.id ?? "");
  if (!id) return json(400, { error: "missing id" });
  const t = await findTicket(ctx, id);
  if (!t) return json(404, { error: "not found" });
  t.clientId = body.clientId != null && body.clientId !== "" ? String(body.clientId) : undefined;
  t.assetId = body.assetId != null && body.assetId !== "" ? String(body.assetId) : undefined;
  t.updated_at = new Date().toISOString();
  await saveTicket(ctx.ticketStore, t);
  return json(200, { ok: true, clientId: t.clientId ?? null, assetId: t.assetId ?? null });
}

async function createClient(ctx: ConsoleCtx, req: ServerRequest): Promise<ServerResponse> {
  const body = parseBody(req);
  const name = String(body.name ?? "").trim();
  if (!name) return json(400, { error: "missing name" });
  const domain = body.domain != null ? String(body.domain).trim() || undefined : undefined;
  const c = newClient(name, domain);
  await saveClient(ctx.clientStore, c);
  return json(200, { ok: true, client: c });
}

async function addClientAsset(ctx: ConsoleCtx, req: ServerRequest): Promise<ServerResponse> {
  const body = parseBody(req);
  const clientId = String(body.clientId ?? "");
  const name = String(body.name ?? "").trim();
  if (!clientId || !name) return json(400, { error: "missing clientId or name" });
  const clients = await loadClients(ctx.clientStore);
  const c = clients.find((x) => x.id === clientId);
  if (!c) return json(404, { error: "client not found" });
  const a = newAsset(name, body.type != null ? String(body.type) : undefined);
  c.assets = c.assets || [];
  c.assets.push(a);
  await saveClient(ctx.clientStore, c);
  return json(200, { ok: true, asset: a, client: c });
}

interface ActivityEvent {
  at: string;
  actor: string;
  kind: "new" | "status" | "turn" | "arnie";
  ticketId: string;
  subject?: string;
  status?: string;
  tier?: number | null;
  role?: string;
}

/**
 * Reconstruct a recent event timeline. tickets.jsonl is append-only — each save
 * is a fresh snapshot — so diffing consecutive snapshots of the same ticket
 * yields its transitions (intake, status changes, client replies). Arnie's
 * finished outcomes are merged in. Newest first, capped.
 */
async function activity(ctx: ConsoleCtx): Promise<ActivityEvent[]> {
  const raw = await fsp.readFile(ctx.ticketStore, "utf8").catch(() => "");
  const prev = new Map<string, Ticket>();
  const events: ActivityEvent[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    let t: Ticket;
    try {
      t = JSON.parse(line) as Ticket;
    } catch {
      continue;
    }
    const p = prev.get(t.id);
    if (!p) events.push({ at: t.created_at, actor: "client", kind: "new", ticketId: t.id, subject: t.subject });
    if (t.status !== "new" && (!p || p.status !== t.status)) {
      events.push({ at: t.updated_at, actor: "casey", kind: "status", status: t.status, tier: t.tier ?? t.triage?.tier ?? null, ticketId: t.id, subject: t.subject });
    }
    const grew = (t.thread?.length ?? 0) > (p?.thread?.length ?? 0);
    if (p && grew) {
      const last = t.thread[t.thread.length - 1];
      // casey's own moves already show as status events; surface client comebacks.
      if (last.role === "client") events.push({ at: last.at, actor: "client", kind: "turn", role: "client", ticketId: t.id, subject: t.subject });
    }
    prev.set(t.id, t);
  }
  if (ctx.arnieQueue) {
    const inbox = path.join(ctx.arnieQueue, "inbox");
    const entries = await fsp.readdir(inbox).catch(() => [] as string[]);
    for (const f of entries.filter((e) => e.endsWith(".outcome.json"))) {
      const oc = await readJson<ArnieOutcome>(path.join(inbox, f));
      if (oc?.finished_at) {
        const id = f.slice(0, -".outcome.json".length);
        events.push({ at: oc.finished_at, actor: "arnie", kind: "arnie", status: oc.status, ticketId: id, subject: prev.get(id)?.subject });
      }
    }
  }
  events.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  return events.slice(0, 60);
}

/** Register the console page + its JSON API on the shared HTTP server. */
export function registerConsole(server: ChannelServer, ctx: ConsoleCtx): void {
  server.route("GET", "/console", async () => ({
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: CONSOLE_HTML,
  }));

  server.route("GET", "/api/tickets", async () => {
    const tickets = await loadTickets(ctx.ticketStore);
    tickets.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return json(200, { tickets: tickets.map(summarize) });
  });

  server.route("GET", "/api/ticket", async (req) => {
    const id = req.query.id;
    if (!id) return json(400, { error: "missing id" });
    const t = await findTicket(ctx, id);
    if (!t) return json(404, { error: "not found" });
    return json(200, { ticket: { ...t, sla: computeSla(t) }, arnie: await arnieState(ctx, id) });
  });

  server.route("GET", "/api/health", async () => json(200, await health(ctx)));
  server.route("GET", "/api/activity", async () => json(200, { events: await activity(ctx) }));

  server.route("POST", "/api/ticket/close", (req) => mutateStatus(ctx, req, "closed"));
  server.route("POST", "/api/ticket/reopen", (req) => mutateStatus(ctx, req, "awaiting_client"));
  server.route("POST", "/api/ticket/redispatch", (req) => redispatch(ctx, req));
  server.route("POST", "/api/ticket/reply", (req) => reply(ctx, req));
  server.route("POST", "/api/ticket/approve", (req) => decide(ctx, req, "approved"));
  server.route("POST", "/api/ticket/reject", (req) => decide(ctx, req, "rejected"));
  server.route("GET", "/api/clients", async () => json(200, { clients: await loadClients(ctx.clientStore) }));
  server.route("POST", "/api/clients", (req) => createClient(ctx, req));
  server.route("POST", "/api/client/asset", (req) => addClientAsset(ctx, req));
  server.route("POST", "/api/ticket/client", (req) => setTicketClient(ctx, req));
  server.route("POST", "/api/ticket/assign", (req) => assignTicket(ctx, req));
}

// ---------------------------------------------------------------------------
// The single-pane app. Self-contained (inline CSS + JS, no build, no deps).
// NOTE: this is a TS template literal — the embedded client JS deliberately
// avoids backticks and ${...} (uses string concatenation + DOM building) so
// nothing here needs escaping.
// ---------------------------------------------------------------------------
export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Casey Console</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --panel2:#12151b; --line:#232732; --me:#2563eb; --them:#232732;
          --text:#e7e9ee; --dim:#8b90a0; --green:#22c55e; --amber:#f59e0b; --red:#ef4444; --chip:#1f2430; }
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; }
  body { background:var(--bg); color:var(--text); font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
         display:flex; flex-direction:column; height:100vh; }
  header.top { display:flex; align-items:center; gap:14px; padding:10px 16px; background:#11141a; border-bottom:1px solid var(--line); }
  header.top b { font-size:15px; }
  .grow { flex:1; }
  .tabs { display:flex; gap:6px; }
  .tab { padding:6px 14px; border:1px solid var(--line); background:var(--panel2); color:var(--dim);
         border-radius:8px; cursor:pointer; font-weight:600; }
  .tab.active { background:var(--me); color:#fff; border-color:var(--me); }
  .live { display:flex; align-items:center; gap:7px; color:var(--dim); font-size:12.5px; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--dim); display:inline-block; }
  .dot.up, .dot.idle { background:var(--green); }
  .dot.working { background:var(--amber); }
  .dot.down, .dot.stalled { background:var(--red); }
  main { flex:1; min-height:0; }

  /* Admin view: KPI strip over (sidebar + detail) */
  #admin { display:flex; flex-direction:column; height:100%; }
  .adminbody { display:flex; flex:1; min-height:0; }
  .kpi { display:flex; gap:8px; flex-wrap:wrap; padding:9px 12px; border-bottom:1px solid var(--line); background:#10131a; }
  .kpi .k { display:flex; flex-direction:column; gap:3px; padding:5px 14px; border-right:1px solid var(--line); }
  .kpi .k:last-child { border-right:0; }
  .kpi .n { font-size:19px; font-weight:700; line-height:1; }
  .kpi .n.warn { color:var(--amber); } .kpi .n.bad { color:var(--red); } .kpi .n.good { color:var(--green); }
  .kpi .l { font-size:10.5px; color:var(--dim); text-transform:uppercase; letter-spacing:.06em; white-space:nowrap; }
  .kpi .bars { display:flex; gap:5px; }
  .kpi .bars .b { font-size:12px; padding:0 7px; border-radius:20px; background:var(--chip); border:1px solid var(--line); }
  .side { width:330px; min-width:300px; border-right:1px solid var(--line); display:flex; flex-direction:column; background:var(--panel2); }
  .side .hd { padding:10px 12px; border-bottom:1px solid var(--line); display:flex; gap:8px; align-items:center; }
  select, .btn { background:var(--chip); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:6px 10px; font:inherit; cursor:pointer; }
  .btn:hover { border-color:#3a4150; }
  .btn.primary { background:var(--me); border-color:var(--me); color:#fff; font-weight:600; }
  .btn.warn { background:#3a1d1d; border-color:#5b2b2b; color:#ffb4b4; }
  .btn:disabled { opacity:.5; cursor:default; }
  #list { flex:1; overflow-y:auto; }
  .row { padding:10px 12px; border-bottom:1px solid var(--line); cursor:pointer; }
  .row:hover { background:#1b1f28; }
  .row.sel { background:#1d2330; box-shadow: inset 3px 0 0 var(--me); }
  .row .subj { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .row .sub { color:var(--dim); font-size:12px; margin-top:2px; display:flex; gap:6px; align-items:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .chip { font-size:11px; padding:1px 7px; border-radius:20px; background:var(--chip); border:1px solid var(--line); white-space:nowrap; }
  .t1 { color:var(--green); border-color:#1f3b29; } .t2 { color:var(--amber); border-color:#3f3315; } .t3 { color:var(--red); border-color:#3f1f1f; }
  .st-resolved { color:var(--green); } .st-escalated { color:var(--red); } .st-troubleshooting,.st-awaiting_client { color:var(--amber); } .st-closed,.st-new { color:var(--dim); }
  .health { border-top:1px solid var(--line); padding:10px 12px; font-size:12.5px; color:var(--dim); display:flex; flex-direction:column; gap:5px; }
  .health .hrow { display:flex; align-items:center; gap:8px; }

  .detail { flex:1; overflow-y:auto; padding:18px 22px; }
  .detail .empty { color:var(--dim); margin-top:40px; text-align:center; }
  .dh { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
  .dh h2 { margin:0; font-size:18px; }
  .meta { color:var(--dim); font-size:12.5px; margin:4px 0 14px; }
  .sec { margin:18px 0 6px; font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--dim); }
  .thread { display:flex; flex-direction:column; gap:9px; }
  .bub { max-width:80%; padding:9px 13px; border-radius:13px; white-space:pre-wrap; word-wrap:break-word; }
  .bub.client { background:var(--them); align-self:flex-start; border-bottom-left-radius:4px; }
  .bub.casey { background:var(--me); align-self:flex-end; border-bottom-right-radius:4px; }
  .bub .who { font-size:11px; color:#cdd3e0; opacity:.8; margin-bottom:2px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:3px 14px; font-size:13px; }
  .kv b { color:var(--dim); font-weight:500; }
  pre.report { background:#0c0e12; border:1px solid var(--line); border-radius:10px; padding:12px; max-height:420px; overflow:auto;
               white-space:pre-wrap; word-wrap:break-word; font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color:#cfd6e4; }
  .actions { display:flex; gap:8px; flex-wrap:wrap; margin:8px 0; }
  .replybox { display:flex; gap:8px; margin-top:8px; }
  .replybox textarea { flex:1; resize:vertical; min-height:42px; background:#0f1115; color:var(--text); border:1px solid var(--line); border-radius:9px; padding:9px 12px; font:inherit; }
  .toast { position:fixed; bottom:18px; left:50%; transform:translateX(-50%); background:#1d2330; border:1px solid var(--line);
           padding:9px 16px; border-radius:9px; color:var(--text); opacity:0; transition:opacity .2s; pointer-events:none; max-width:80vw; }
  .toast.show { opacity:1; }

  /* search */
  #search { width:100%; background:#0f1115; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:6px 10px; font:inherit; }
  /* activity feed */
  .feed { display:flex; flex-direction:column; }
  .feed .ev { display:flex; gap:10px; align-items:baseline; padding:7px 6px; border-bottom:1px solid #1a1e27; cursor:pointer; border-radius:6px; }
  .feed .ev:hover { background:#1b1f28; }
  .feed .et { color:var(--dim); font-size:12px; font-variant-numeric:tabular-nums; white-space:nowrap; min-width:64px; }
  .feed .ei { width:16px; text-align:center; }
  .feed .ex { flex:1; min-width:0; }
  .feed .ex .es { color:var(--dim); }
  .backbtn { cursor:pointer; color:var(--me); font-size:13px; margin-bottom:8px; display:inline-block; }
  .backbtn:hover { text-decoration:underline; }
  /* roles */
  .rolewrap { color:var(--dim); font-size:12px; display:flex; align-items:center; gap:6px; }
  #role { background:var(--chip); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:5px 8px; font:inherit; }
  .rolenote { color:var(--dim); font-size:12.5px; background:#10131a; border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-bottom:10px; }
  .planned { max-width:520px; margin:46px auto; text-align:center; background:var(--panel); border:1px dashed #2a2f3a; border-radius:12px; padding:28px; }
  .planned .pl { font-size:11px; letter-spacing:.08em; color:var(--amber); margin-bottom:8px; }
  .planned h2 { margin:0 0 8px; }
  .planned .plb { color:var(--dim); }
  .sla-breached, .sla-missed { color:var(--red); border-color:#3f1f1f; }
  .sla-at_risk { color:var(--amber); border-color:#3f3315; }
  .sla-met { color:var(--green); border-color:#1f3b29; }
  .sla-ok { color:var(--dim); }
  /* User view: chat */
  #user { height:100%; display:flex; align-items:center; justify-content:center; }
  .chat { width:min(560px,94vw); height:min(720px,94%); background:var(--panel); border-radius:14px; display:flex; flex-direction:column; overflow:hidden; border:1px solid var(--line); }
  .chat .ch { padding:13px 16px; background:#11141a; border-bottom:1px solid var(--line); }
  .chat .ch b { font-size:14px; } .chat .ch span { display:block; color:var(--dim); font-size:12px; margin-top:2px; }
  #ulog { flex:1; overflow-y:auto; padding:14px; display:flex; flex-direction:column; gap:9px; }
  #uform { display:flex; gap:8px; padding:11px; border-top:1px solid var(--line); background:var(--panel2); }
  #utext { flex:1; resize:none; height:42px; padding:10px 12px; border:1px solid var(--line); background:#0f1115; color:var(--text); border-radius:9px; font:inherit; }
</style>
</head>
<body>
  <header class="top">
    <b>Casey Console</b>
    <div class="tabs">
      <div class="tab" id="tab-user">User</div>
      <div class="tab active" id="tab-admin">Admin / Dev</div>
    </div>
    <div class="rolewrap">role <select id="role"></select></div>
    <div class="grow"></div>
    <div class="live" id="live"><span class="dot" id="d-casey"></span>casey
      <span class="dot" id="d-arnie"></span>arnie
      <span class="dot" id="d-dario"></span>dario</div>
  </header>
  <main>
    <div id="admin">
      <div class="kpi" id="kpi"></div>
      <div class="adminbody">
        <div class="side">
          <div class="hd"><input id="search" type="text" placeholder="Search tickets…" autocomplete="off" /></div>
          <div class="hd">
            <select id="filter">
              <option value="all">All tickets</option>
              <option value="open">Open</option>
              <option value="escalated">Escalated</option>
              <option value="resolved">Resolved</option>
              <option value="closed">Closed</option>
            </select>
            <button class="btn" id="refresh">Refresh</button>
            <button class="btn" id="showfeed">Activity</button>
          </div>
          <div id="list"></div>
          <div class="health" id="healthPanel"></div>
        </div>
        <div class="detail" id="detail"></div>
      </div>
    </div>
    <div id="user" style="display:none">
      <div class="chat">
        <div class="ch"><b>IT Support (preview)</b><span>This is the live client chat — messages run through Casey's real pipeline.</span></div>
        <div id="ulog"></div>
        <form id="uform">
          <textarea id="utext" placeholder="Describe an issue as a client would…" autofocus></textarea>
          <button class="btn primary" id="usend" type="submit">Send</button>
        </form>
      </div>
    </div>
  </main>
  <div class="toast" id="toast"></div>
<script>
  var state = { tickets: [], selected: null, filter: "all", view: "admin", search: "", health: null, detailSig: null, role: "owner", clients: [] };

  function preserveScroll(node, fn) {
    var top = node ? node.scrollTop : 0;
    fn();
    if (node) node.scrollTop = top;
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg; t.classList.add("show");
    setTimeout(function(){ t.classList.remove("show"); }, 2600);
  }
  function ago(iso) {
    if (!iso) return "";
    var s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s/60) + "m ago";
    if (s < 86400) return Math.floor(s/3600) + "h ago";
    return Math.floor(s/86400) + "d ago";
  }
  function tierChip(tier) {
    var c = el("span", "chip" + (tier ? " t" + tier : ""), tier ? ("T" + tier) : "T?");
    return c;
  }

  // ---- view switching ----
  function setView(v) {
    state.view = v;
    document.getElementById("admin").style.display = v === "admin" ? "flex" : "none";
    document.getElementById("user").style.display = v === "user" ? "flex" : "none";
    document.getElementById("tab-admin").classList.toggle("active", v === "admin");
    document.getElementById("tab-user").classList.toggle("active", v === "user");
  }
  document.getElementById("tab-admin").onclick = function(){ setView("admin"); };
  document.getElementById("tab-user").onclick = function(){ setView("user"); };

  // ---- admin: list + health ----
  // ---- roles: each team is a scoped view of the one pane (no auth yet) ----
  var ROLES = [
    { id:"owner", label:"Owner / Manager", live:true, filter:"all", actions:["approve","reject","close","reopen","redispatch","reply","client","assign"],
      blurb:"Oversight — the whole desk. KPIs up top, live activity below." },
    { id:"csr", label:"Service Desk / CSR", live:true, filter:"open", actions:["reply","close","reopen","client"],
      blurb:"Intake + triage. Use the User tab to take a ticket — casey drafts the triage, you confirm/correct. Set the client + asset." },
    { id:"dispatch", label:"Dispatch", live:true, filter:"open", sort:"sla", actions:["assign","redispatch","close","reply","client"],
      blurb:"All open work, most SLA-urgent first. Assign owners; watch breaches." },
    { id:"t3", label:"T3 / Approver", live:true, scope:"escalations", filter:"all", actions:["approve","reject","redispatch","close","reply"],
      blurb:"Arnie escalations awaiting sign-off. Approve authorizes the proposed remediation (arnie executes once execute-on-approval ships); reject sends it back." },
    { id:"security", label:"Security", live:true, scope:"category:security", filter:"all", actions:["approve","reject","redispatch","close","reply"],
      blurb:"Security-classed tickets + escalations to sign off on." },
    { id:"backup", label:"Backup", live:false, phase:3, blurb:"Backup-failure queue + restore approvals. Needs alert intake + the asset model." },
    { id:"bench", label:"Bench", live:false, phase:3, blurb:"Device-prep / imaging / RMA queue. Needs the asset model + procurement handoff." },
    { id:"procurement", label:"Procurement", live:false, phase:3, blurb:"Purchase orders + vendor management; hands off to Bench." },
    { id:"project", label:"Project", live:false, phase:4, blurb:"Project board — phases, tasks, assignment, time. Human-run (no AI execution yet)." },
    { id:"sales", label:"Sales", live:false, phase:5, blurb:"Pipeline + leads; casey splits intake-vs-lead at the front door." },
    { id:"am", label:"Account Manager", live:false, phase:5, blurb:"Client book, health, QBR reporting. Needs the client model." },
    { id:"accounting", label:"Accounting / HR", live:false, phase:5, blurb:"Billable time to invoice; contract usage. Needs time tracking." },
    { id:"dev", label:"Dev", live:false, phase:6, blurb:"Custom work + authoring arnie remediation playbooks." }
  ];
  function activeRole() { for (var i=0;i<ROLES.length;i++){ if (ROLES[i].id===state.role) return ROLES[i]; } return ROLES[0]; }
  function roleScope(t) {
    var r = activeRole();
    if (!r.scope) return true;
    if (r.scope === "escalations") return t.status === "escalated";
    if (r.scope.indexOf("category:") === 0) return t.category === r.scope.slice(9);
    return true;
  }
  function roleAllows(a) {
    var r = activeRole();
    return !!(r.live && r.actions && r.actions.indexOf(a) >= 0);
  }
  function applyRole() {
    var r = activeRole();
    localStorage.setItem("casey_role", r.id);
    var sel = document.getElementById("role"); if (sel) sel.value = r.id;
    if (!r.live) {
      state.selected = null;
      var list = document.getElementById("list");
      list.innerHTML = ""; list.appendChild(el("div", "row", "— view not wired yet —"));
      var d = document.getElementById("detail"); d.innerHTML = "";
      var card = el("div", "planned");
      card.appendChild(el("div", "pl", "PLANNED · PHASE " + r.phase));
      card.appendChild(el("h2", null, r.label));
      card.appendChild(el("div", "plb", r.blurb || ""));
      d.appendChild(card);
      renderKpi();
      return;
    }
    state.filter = r.filter || "all";
    var fsel = document.getElementById("filter"); if (fsel) fsel.value = state.filter;
    renderList();
    renderKpi();
    showFeed();
  }

  function matchesSearch(t) {
    var q = state.search.trim().toLowerCase();
    if (!q) return true;
    return [t.subject, t.from, t.id, t.category, t.priority, t.status].some(function(v){ return v && String(v).toLowerCase().indexOf(q) >= 0; });
  }
  function passesFilter(t) {
    if (!roleScope(t)) return false;
    if (!matchesSearch(t)) return false;
    var f = state.filter;
    if (f === "all") return true;
    if (f === "open") return ["new","awaiting_client","troubleshooting","escalated"].indexOf(t.status) >= 0;
    return t.status === f;
  }
  function renderList() {
    var list = document.getElementById("list");
    if (!activeRole().live) { list.innerHTML = ""; list.appendChild(el("div", "row", "— view not wired yet —")); return; }
    preserveScroll(list, function() {
      list.innerHTML = "";
      var shown = state.tickets.filter(passesFilter);
      if (activeRole().sort === "priority") {
        var ord = { P1:0, P2:1, P3:2, P4:3 };
        shown.sort(function(a,b){ return (ord[a.priority]==null?9:ord[a.priority]) - (ord[b.priority]==null?9:ord[b.priority]); });
      } else if (activeRole().sort === "sla") {
        var rank = { breached:0, at_risk:1, ok:2, missed:3, met:4 };
        shown.sort(function(a,b){
          var ra = rank[(a.sla && a.sla.state) || "ok"]; var rb = rank[(b.sla && b.sla.state) || "ok"];
          if (ra !== rb) return ra - rb;
          var da = (a.sla && a.sla.dueMs != null) ? a.sla.dueMs : 1e15; var db = (b.sla && b.sla.dueMs != null) ? b.sla.dueMs : 1e15;
          return da - db;
        });
      }
      if (!shown.length) { list.appendChild(el("div", "row", "No tickets match.")); return; }
      shown.forEach(function(t) {
        var row = el("div", "row" + (t.id === state.selected ? " sel" : ""));
        row.appendChild(el("div", "subj", t.subject || "(no subject)"));
        var sub = el("div", "sub");
        sub.appendChild(tierChip(t.tier));
        if (t.priority) sub.appendChild(el("span", "chip", t.priority));
        sub.appendChild(el("span", "st-" + t.status, t.status));
        if (t.status === "escalated" && !t.approval) sub.appendChild(el("span", "chip", "⏳ approve"));
        var cn = t.clientId ? clientName(t.clientId) : null;
        if (cn) sub.appendChild(el("span", "chip", cn));
        if (t.sla && t.sla.state && t.sla.state !== "ok" && t.sla.state !== "met") sub.appendChild(el("span", "chip sla-" + t.sla.state, slaLabel(t.sla) || t.sla.state));
        if (t.assignee) sub.appendChild(el("span", null, "· @" + t.assignee));
        sub.appendChild(el("span", null, "· " + (t.from || "")));
        row.appendChild(sub);
        row.appendChild(el("div", "sub", ago(t.updated_at) + " · " + (t.channel || "")));
        row.onclick = function(){ selectTicket(t.id); };
        list.appendChild(row);
      });
    });
  }
  function setDot(id, st) {
    var d = document.getElementById(id);
    d.className = "dot" + (st ? " " + st : "");
  }
  function renderHealth(h) {
    state.health = h;
    setDot("d-casey", h.casey ? h.casey.state : "");
    setDot("d-arnie", h.arnie ? h.arnie.state : "");
    setDot("d-dario", h.dario ? h.dario.state : "");
    var p = document.getElementById("healthPanel");
    p.innerHTML = "";
    function line(label, dotState, detail) {
      var r = el("div", "hrow");
      var d = el("span", "dot" + (dotState ? " " + dotState : ""));
      r.appendChild(d);
      r.appendChild(el("span", null, label + " — " + detail));
      p.appendChild(r);
    }
    line("casey", h.casey.state, "serving :this port");
    var a = h.arnie || {};
    line("arnie", a.state, (a.state || "?") + (a.pending ? (" · " + a.pending + " pending") : "") + (a.pending && a.oldestAgeMs ? (" · oldest " + Math.round(a.oldestAgeMs/1000) + "s") : ""));
    var dd = h.dario || {};
    line("dario", dd.state, (dd.state || "?") + (dd.detail ? (" · " + dd.detail) : ""));
    if (h.tickets) {
      var t = h.tickets;
      var parts = [];
      Object.keys(t.byStatus || {}).forEach(function(k){ parts.push(k + ":" + t.byStatus[k]); });
      p.appendChild(el("div", "hrow", t.total + " tickets · " + t.today + " today"));
      if (parts.length) p.appendChild(el("div", "hrow", parts.join("  ")));
    }
    renderKpi();
  }

  function renderKpi() {
    var k = document.getElementById("kpi");
    if (!k) return;
    var ts = state.tickets;
    var openS = ["new","awaiting_client","troubleshooting","escalated"];
    var open = ts.filter(function(t){ return openS.indexOf(t.status) >= 0; });
    var p1 = open.filter(function(t){ return t.priority === "P1"; });
    var todayStr = new Date().toISOString().slice(0,10);
    var today = ts.filter(function(t){ return (t.created_at||"").slice(0,10) === todayStr; });
    var resolved = ts.filter(function(t){ return t.status === "resolved"; }).length;
    var closed = ts.filter(function(t){ return t.status === "closed"; }).length;
    var byTier = {1:0,2:0,3:0};
    open.forEach(function(t){ if (t.tier) byTier[t.tier] = (byTier[t.tier]||0)+1; });
    var pending = state.health && state.health.arnie ? (state.health.arnie.pending||0) : 0;
    var needsAppr = ts.filter(function(t){ return t.status === "escalated" && !t.approval; }).length;
    var slaBreached = ts.filter(function(t){ return t.sla && t.sla.state === "breached"; }).length;
    k.innerHTML = "";
    function card(n, label, cls) {
      var c = el("div", "k");
      c.appendChild(el("div", "n" + (cls ? " " + cls : ""), String(n)));
      c.appendChild(el("div", "l", label));
      return c;
    }
    k.appendChild(card(open.length, "open", open.length ? "" : "good"));
    k.appendChild(card(p1.length, "P1 open", p1.length ? "bad" : ""));
    k.appendChild(card(today.length, "today"));
    k.appendChild(card(needsAppr, "needs approval", needsAppr ? "warn" : ""));
    k.appendChild(card(slaBreached, "SLA breached", slaBreached ? "bad" : ""));
    k.appendChild(card(pending, "escalating→arnie", pending ? "warn" : ""));
    var tc = el("div", "k");
    var bars = el("div", "bars");
    bars.appendChild(el("span", "b t1", "T1 " + byTier[1]));
    bars.appendChild(el("span", "b t2", "T2 " + byTier[2]));
    bars.appendChild(el("span", "b t3", "T3 " + byTier[3]));
    tc.appendChild(bars);
    tc.appendChild(el("div", "l", "open by tier"));
    k.appendChild(tc);
    k.appendChild(card(resolved + " / " + closed, "resolved / closed", "good"));
  }

  async function loadTickets(keepSel) {
    try {
      var res = await fetch("/api/tickets");
      var data = await res.json();
      state.tickets = data.tickets || [];
      if (keepSel && state.selected && !state.tickets.some(function(t){ return t.id === state.selected; })) state.selected = null;
      renderList();
      renderKpi();
    } catch (e) { /* transient */ }
  }
  async function loadHealth() {
    try {
      var res = await fetch("/api/health");
      renderHealth(await res.json());
    } catch (e) { /* transient */ }
  }
  async function loadClientsList() {
    try { var res = await fetch("/api/clients"); var d = await res.json(); state.clients = d.clients || []; } catch (e) { /* transient */ }
  }
  function clientById(id) { for (var i=0;i<state.clients.length;i++){ if (state.clients[i].id === id) return state.clients[i]; } return null; }
  function clientName(id) { var c = clientById(id); return c ? c.name : null; }
  function assetName(cid, aid) { var c = clientById(cid); if (!c || !c.assets) return null; for (var i=0;i<c.assets.length;i++){ if (c.assets[i].id === aid) return c.assets[i].name; } return null; }
  async function setClient(ticketId, clientId, assetId) {
    await fetch("/api/ticket/client", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ id: ticketId, clientId: clientId || "", assetId: assetId || "" }) });
    await loadTickets(true); selectTicket(ticketId, true);
  }
  function slaLabel(s) {
    if (!s) return null;
    if (s.state === "met") return "SLA met";
    if (s.state === "missed") return "SLA missed";
    if (s.dueMs == null) return null;
    var m = Math.abs(s.dueMs);
    var txt = m < 3600000 ? (Math.round(m/60000) + "m") : (m < 86400000 ? (Math.round(m/3600000) + "h") : (Math.round(m/86400000) + "d"));
    return s.state === "breached" ? ("SLA overdue " + txt) : ("SLA " + txt + " left");
  }

  // ---- admin: detail ----
  function detailSig(t, arnie) {
    return [t.updated_at, t.status, t.thread ? t.thread.length : 0, arnie ? arnie.state : "", arnie && arnie.reportText ? arnie.reportText.length : 0].join("|");
  }
  async function selectTicket(id, force) {
    var changing = id !== state.selected;
    state.selected = id;
    var d = document.getElementById("detail");
    if (changing) {
      state.detailSig = null;
      renderList();
      d.innerHTML = ""; d.appendChild(el("div", "empty", "Loading…"));
    }
    try {
      var res = await fetch("/api/ticket?id=" + encodeURIComponent(id));
      if (!res.ok) { if (changing) { d.innerHTML = ""; d.appendChild(el("div","empty","Could not load ticket.")); } return; }
      var data = await res.json();
      var sig = detailSig(data.ticket, data.arnie);
      // Background refresh of the same ticket: skip the re-render when nothing
      // changed — re-rendering was what yanked the scroll back to the top.
      if (!force && !changing && sig === state.detailSig) return;
      state.detailSig = sig;
      preserveScroll(changing ? null : d, function(){ renderDetail(data.ticket, data.arnie); });
    } catch (e) {
      if (changing) { d.innerHTML = ""; d.appendChild(el("div","empty","Error loading ticket.")); }
    }
  }

  function renderDetail(t, arnie) {
    var d = document.getElementById("detail");
    d.innerHTML = "";
    var tr = t.triage || {};

    var back = el("div", "backbtn", "← Activity");
    back.onclick = showFeed;
    d.appendChild(back);

    var dh = el("div", "dh");
    dh.appendChild(el("h2", null, t.subject || "(no subject)"));
    dh.appendChild(tierChip(t.tier || tr.tier));
    if (tr.priority) dh.appendChild(el("span", "chip", tr.priority));
    dh.appendChild(el("span", "chip st-" + t.status, t.status));
    d.appendChild(dh);
    d.appendChild(el("div", "meta", t.id + " · " + (t.channel || "") + " · from " + (t.from || "") + " · created " + ago(t.created_at) + " · updated " + ago(t.updated_at)));
    d.appendChild(el("div", "meta", "SLA: " + (slaLabel(t.sla) || (t.sla ? t.sla.state : "—")) + (t.assignee ? ("   ·   assigned: " + t.assignee) : "")));

    // Client / Asset
    var cName = t.clientId ? (clientName(t.clientId) || t.clientId) : null;
    var aName = (t.clientId && t.assetId) ? (assetName(t.clientId, t.assetId) || t.assetId) : null;
    if (cName || roleAllows("client")) {
      d.appendChild(el("div", "sec", "Client / Asset"));
      var cc = el("div", "card");
      cc.appendChild(el("div", null, "client: " + (cName || "— unassigned —") + (aName ? ("   ·   asset: " + aName) : "")));
      if (roleAllows("client")) {
        var crow = el("div", "actions");
        var csel = document.createElement("select"); csel.className = "btn";
        var on = document.createElement("option"); on.value = ""; on.textContent = "— client —"; csel.appendChild(on);
        state.clients.forEach(function(c){ var o = document.createElement("option"); o.value = c.id; o.textContent = c.name; csel.appendChild(o); });
        var onew = document.createElement("option"); onew.value = "__new"; onew.textContent = "+ new client…"; csel.appendChild(onew);
        csel.value = t.clientId || "";
        csel.onchange = async function(){
          if (csel.value === "__new") {
            var nm = prompt("New client name:"); if (!nm) { csel.value = t.clientId || ""; return; }
            var r = await fetch("/api/clients", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ name: nm }) });
            var dd = await r.json(); if (dd.client) { await loadClientsList(); toast("client created"); await setClient(t.id, dd.client.id, ""); }
            return;
          }
          await setClient(t.id, csel.value, "");
          toast("client set");
        };
        crow.appendChild(csel);
        if (t.clientId) {
          var c = clientById(t.clientId);
          var asel = document.createElement("select"); asel.className = "btn";
          var an = document.createElement("option"); an.value = ""; an.textContent = "— asset —"; asel.appendChild(an);
          ((c && c.assets) || []).forEach(function(a){ var o = document.createElement("option"); o.value = a.id; o.textContent = a.name; asel.appendChild(o); });
          var anew = document.createElement("option"); anew.value = "__new"; anew.textContent = "+ new asset…"; asel.appendChild(anew);
          asel.value = t.assetId || "";
          asel.onchange = async function(){
            if (asel.value === "__new") {
              var nm = prompt("New asset (hostname / label):"); if (!nm) { asel.value = t.assetId || ""; return; }
              var r = await fetch("/api/client/asset", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ clientId: t.clientId, name: nm }) });
              var dd = await r.json(); if (dd.asset) { await loadClientsList(); toast("asset added"); await setClient(t.id, t.clientId, dd.asset.id); }
              return;
            }
            await setClient(t.id, t.clientId, asel.value);
            toast("asset set");
          };
          crow.appendChild(asel);
        }
        cc.appendChild(crow);
      }
      d.appendChild(cc);
    }

    // Actions (role-scoped)
    var canClose = roleAllows(t.status === "closed" ? "reopen" : "close");
    var canRedo = roleAllows("redispatch");
    var canReply = roleAllows("reply");
    var canAssign = roleAllows("assign");
    if (canClose || canRedo || canAssign) {
      d.appendChild(el("div", "sec", "Actions"));
      var actions = el("div", "actions");
      if (canAssign) {
        var asgn = el("button", "btn", t.assignee ? ("Reassign (" + t.assignee + ")") : "Assign");
        asgn.onclick = async function(){
          var who = prompt("Assign to (name):", t.assignee || "");
          if (who === null) return;
          await fetch("/api/ticket/assign", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ id: t.id, assignee: who }) });
          toast("assigned"); await loadTickets(true); selectTicket(t.id, true);
        };
        actions.appendChild(asgn);
      }
      if (canClose) {
        var closeBtn = el("button", "btn warn", t.status === "closed" ? "Reopen" : "Close");
        closeBtn.onclick = function(){ doAction(t.status === "closed" ? "reopen" : "close", { id: t.id }, t.id); };
        actions.appendChild(closeBtn);
      }
      if (canRedo) {
        var redo = el("button", "btn", "Re-dispatch to Arnie");
        redo.onclick = function(){ doAction("redispatch", { id: t.id }, t.id); };
        actions.appendChild(redo);
      }
      d.appendChild(actions);
    }
    if (canReply) {
      d.appendChild(el("div", "sec", "Reply as Casey"));
      var rb = el("div", "replybox");
      var ta = el("textarea"); ta.placeholder = "Reply as Casey…";
      var sb = el("button", "btn primary", "Send reply");
      sb.onclick = async function(){
        var text = ta.value.trim();
        if (!text) return;
        sb.disabled = true;
        var rr = await doAction("reply", { id: t.id, text: text }, t.id, true);
        sb.disabled = false;
        if (rr) { ta.value = ""; if (rr.note) toast(rr.note); }
      };
      rb.appendChild(ta); rb.appendChild(sb);
      d.appendChild(rb);
    }

    // Thread
    d.appendChild(el("div", "sec", "Thread (" + (t.thread ? t.thread.length : 0) + ")"));
    var th = el("div", "thread");
    (t.thread || []).forEach(function(turn) {
      var b = el("div", "bub " + (turn.role === "client" ? "client" : "casey"));
      b.appendChild(el("div", "who", (turn.role === "client" ? "client" : "Casey") + " · " + ago(turn.at)));
      b.appendChild(el("div", null, turn.text));
      th.appendChild(b);
    });
    d.appendChild(th);

    // Triage
    d.appendChild(el("div", "sec", "Triage"));
    var kvWrap = el("div", "card");
    var kv = el("div", "kv");
    function pair(k, v) { kv.appendChild(el("b", null, k)); kv.appendChild(el("span", null, v == null ? "—" : String(v))); }
    pair("category", tr.category); pair("priority", tr.priority); pair("tier", tr.tier);
    pair("action", tr.action); pair("summary", tr.summary);
    if (tr.missing_info && tr.missing_info.length) pair("missing", tr.missing_info.join("; "));
    kvWrap.appendChild(kv);
    if (tr.escalation_brief) {
      kvWrap.appendChild(el("div", "sec", "Escalation brief"));
      kvWrap.appendChild(el("div", null, tr.escalation_brief));
    }
    d.appendChild(kvWrap);

    // Arnie
    d.appendChild(el("div", "sec", "Arnie (Tier-3)"));
    var ac = el("div", "card");
    var astate = arnie ? arnie.state : "n/a";
    var oc = arnie && arnie.outcome ? arnie.outcome : null;
    ac.appendChild(el("div", null, "state: " + astate + (oc && oc.status ? (" · outcome: " + oc.status) : "") + (oc && oc.finished_at ? (" · " + ago(oc.finished_at)) : "")));
    if (arnie && arnie.reportPath) ac.appendChild(el("div", "meta", "report: " + arnie.reportPath));
    if (arnie && arnie.auditPath) ac.appendChild(el("div", "meta", "audit: " + arnie.auditPath));
    if (arnie && arnie.reportText) {
      var pre = el("pre", "report", arnie.reportText);
      ac.appendChild(pre);
    } else if (astate === "pending") {
      ac.appendChild(el("div", "meta", "queued — waiting for Arnie to claim it (polls every 15s)."));
    } else if (astate === "working") {
      ac.appendChild(el("div", "meta", "claimed — Arnie is working it; the report will appear here when done."));
    } else if (astate === "none") {
      ac.appendChild(el("div", "meta", "not escalated to Arnie."));
    }
    d.appendChild(ac);

    // Approval — T3 / discipline sign-off on an escalated remediation
    var ap = t.approval;
    var canApprove = roleAllows("approve");
    var canReject = roleAllows("reject");
    if (ap || (t.status === "escalated" && (canApprove || canReject))) {
      d.appendChild(el("div", "sec", "Approval"));
      var apc = el("div", "card");
      if (ap) {
        apc.appendChild(el("div", null, (ap.decision === "approved" ? "✓ APPROVED" : "✗ REJECTED") + " · " + ap.by + " · " + ago(ap.at) + (ap.note ? (" · " + ap.note) : "")));
      } else {
        apc.appendChild(el("div", "meta", "Escalated for sign-off. Approve authorizes the proposed remediation (arnie execute-on-approval ships next); reject sends it back."));
      }
      if (canApprove || canReject) {
        var arow = el("div", "actions");
        if (canApprove) { var ab = el("button", "btn primary", ap ? "Re-approve" : "Approve"); ab.onclick = function(){ doAction("approve", { id: t.id }, t.id); }; arow.appendChild(ab); }
        if (canReject) { var rjb = el("button", "btn warn", "Reject"); rjb.onclick = function(){ doAction("reject", { id: t.id }, t.id); }; arow.appendChild(rjb); }
        apc.appendChild(arow);
      }
      d.appendChild(apc);
    }
  }

  // ---- admin: activity feed (default detail view) ----
  function evIcon(e) {
    if (e.kind === "arnie") return e.status === "escalated" ? "⤴" : "✅";
    if (e.kind === "new") return "✉";
    if (e.kind === "turn") return "↩";
    if (e.status === "escalated") return "🔺";
    if (e.status === "resolved") return "✓";
    if (e.status === "closed") return "■";
    return "•";
  }
  function evText(e) {
    if (e.kind === "new") return "ticket in";
    if (e.kind === "turn") return "client replied";
    if (e.kind === "arnie") return "arnie " + (e.status || "done");
    if (e.status === "escalated") return "escalated → arnie";
    if (e.status === "resolved") return "casey resolved" + (e.tier ? " · T" + e.tier : "");
    if (e.status === "troubleshooting") return "casey T2 troubleshooting";
    if (e.status === "awaiting_client") return "casey asked client";
    if (e.status === "closed") return "closed";
    return e.status || "";
  }
  function renderActivity(events) {
    var feed = document.getElementById("feed");
    if (!feed) return;
    preserveScroll(document.getElementById("detail"), function(){
      feed.innerHTML = "";
      if (!events.length) { feed.appendChild(el("div", "ev", "No activity yet.")); return; }
      events.forEach(function(e){
        var row = el("div", "ev");
        row.appendChild(el("span", "et", ago(e.at)));
        row.appendChild(el("span", "ei", evIcon(e)));
        var x = el("span", "ex");
        x.appendChild(el("b", null, evText(e)));
        if (e.subject) { x.appendChild(document.createTextNode("  ")); x.appendChild(el("span", "es", e.subject)); }
        row.appendChild(x);
        if (e.ticketId) row.onclick = function(){ selectTicket(e.ticketId); };
        feed.appendChild(row);
      });
    });
  }
  async function loadActivity() {
    try { var res = await fetch("/api/activity"); var data = await res.json(); renderActivity(data.events || []); } catch (e) { /* transient */ }
  }
  function showFeed() {
    state.selected = null;
    state.detailSig = null;
    renderList();
    var d = document.getElementById("detail");
    d.innerHTML = "";
    var r = activeRole();
    if (r.blurb) d.appendChild(el("div", "rolenote", r.label + " — " + r.blurb));
    d.appendChild(el("div", "sec", "Activity"));
    var feed = el("div", "feed"); feed.id = "feed";
    d.appendChild(feed);
    loadActivity();
  }

  async function doAction(action, payload, id, returnData) {
    try {
      var res = await fetch("/api/ticket/" + action, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(payload) });
      var data = await res.json();
      if (!res.ok) { toast(data.error || "action failed"); return null; }
      if (action !== "reply") toast(action + " ok");
      await loadTickets(true);
      if (id) await selectTicket(id);
      await loadHealth();
      return returnData ? data : true;
    } catch (e) { toast("error: " + (e && e.message ? e.message : e)); return null; }
  }

  document.getElementById("filter").onchange = function(e){ state.filter = e.target.value; renderList(); };
  document.getElementById("refresh").onclick = function(){ loadTickets(true); loadHealth(); if (state.selected) selectTicket(state.selected, true); else loadActivity(); };
  document.getElementById("search").addEventListener("input", function(e){ state.search = e.target.value; renderList(); });
  document.getElementById("showfeed").onclick = function(){ showFeed(); };

  // ---- user: chat ----
  var usid = localStorage.getItem("casey_console_sid");
  if (!usid) { usid = "console-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); localStorage.setItem("casey_console_sid", usid); }
  function uadd(text, who) {
    var d = el("div", "bub " + (who === "me" ? "casey" : "client"));
    d.appendChild(el("div", null, text));
    var log = document.getElementById("ulog"); log.appendChild(d); log.scrollTop = log.scrollHeight;
  }
  function unote(text) {
    var d = el("div", "meta", text); d.style.alignSelf = "center";
    var log = document.getElementById("ulog"); log.appendChild(d); log.scrollTop = log.scrollHeight;
  }
  document.getElementById("uform").addEventListener("submit", async function(e) {
    e.preventDefault();
    var ta = document.getElementById("utext");
    var text = ta.value.trim(); if (!text) return;
    var send = document.getElementById("usend");
    uadd(text, "me"); ta.value = ""; send.disabled = true; unote("…");
    try {
      var res = await fetch("/web", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ conversationId: usid, from: usid, text: text }) });
      var data = await res.json();
      document.querySelectorAll("#ulog .meta").forEach(function(m){ if (m.textContent === "…") m.remove(); });
      if (data.reply) uadd(data.reply, "them"); else unote("(no reply)");
      loadTickets(true);
    } catch (err) {
      document.querySelectorAll("#ulog .meta").forEach(function(m){ if (m.textContent === "…") m.remove(); });
      unote("Connection error — please try again.");
    } finally { send.disabled = false; document.getElementById("utext").focus(); }
  });
  document.getElementById("utext").addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); document.getElementById("uform").requestSubmit(); }
  });

  // ---- roles: populate switcher ----
  (function(){
    state.role = localStorage.getItem("casey_role") || "owner";
    var sel = document.getElementById("role");
    ROLES.forEach(function(r){ var o = document.createElement("option"); o.value = r.id; o.textContent = r.label + (r.live ? "" : " · planned"); sel.appendChild(o); });
    sel.value = state.role;
    sel.onchange = function(e){ state.role = e.target.value; applyRole(); };
  })();

  // ---- boot + auto-refresh ----
  setView("admin");
  applyRole();
  loadClientsList().then(function(){ renderList(); });
  loadTickets(false);
  loadHealth();
  setInterval(function(){
    if (state.view !== "admin") return;
    loadTickets(true);
    loadHealth();
    if (!activeRole().live) return;
    if (state.selected) selectTicket(state.selected);   // change-detected + scroll-preserving
    else loadActivity();
  }, 5000);
</script>
</body>
</html>`;
