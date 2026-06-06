import fsp from "node:fs/promises";
import path from "node:path";

import { loadTickets, saveTicket, addTurn, type Ticket } from "./ticket.js";
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
    return json(200, { ticket: t, arnie: await arnieState(ctx, id) });
  });

  server.route("GET", "/api/health", async () => json(200, await health(ctx)));

  server.route("POST", "/api/ticket/close", (req) => mutateStatus(ctx, req, "closed"));
  server.route("POST", "/api/ticket/reopen", (req) => mutateStatus(ctx, req, "awaiting_client"));
  server.route("POST", "/api/ticket/redispatch", (req) => redispatch(ctx, req));
  server.route("POST", "/api/ticket/reply", (req) => reply(ctx, req));
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

  /* Admin view: sidebar + detail */
  #admin { display:flex; height:100%; }
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
    <div class="grow"></div>
    <div class="live" id="live"><span class="dot" id="d-casey"></span>casey
      <span class="dot" id="d-arnie"></span>arnie
      <span class="dot" id="d-dario"></span>dario</div>
  </header>
  <main>
    <div id="admin">
      <div class="side">
        <div class="hd">
          <select id="filter">
            <option value="all">All tickets</option>
            <option value="open">Open</option>
            <option value="escalated">Escalated</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
          <button class="btn" id="refresh">Refresh</button>
        </div>
        <div id="list"></div>
        <div class="health" id="healthPanel"></div>
      </div>
      <div class="detail" id="detail"><div class="empty">Select a ticket to inspect its thread, triage, and Arnie outcome.</div></div>
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
  var state = { tickets: [], selected: null, filter: "all", view: "admin" };

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
  function passesFilter(t) {
    var f = state.filter;
    if (f === "all") return true;
    if (f === "open") return ["new","awaiting_client","troubleshooting"].indexOf(t.status) >= 0;
    return t.status === f;
  }
  function renderList() {
    var list = document.getElementById("list");
    list.innerHTML = "";
    var shown = state.tickets.filter(passesFilter);
    if (!shown.length) { list.appendChild(el("div", "row", "No tickets.")); return; }
    shown.forEach(function(t) {
      var row = el("div", "row" + (t.id === state.selected ? " sel" : ""));
      row.appendChild(el("div", "subj", t.subject || "(no subject)"));
      var sub = el("div", "sub");
      sub.appendChild(tierChip(t.tier));
      if (t.priority) sub.appendChild(el("span", "chip", t.priority));
      sub.appendChild(el("span", "st-" + t.status, t.status));
      sub.appendChild(el("span", null, "· " + (t.from || "")));
      row.appendChild(sub);
      var meta = el("div", "sub", ago(t.updated_at) + " · " + (t.channel || ""));
      row.appendChild(meta);
      row.onclick = function(){ selectTicket(t.id); };
      list.appendChild(row);
    });
  }
  function setDot(id, st) {
    var d = document.getElementById(id);
    d.className = "dot" + (st ? " " + st : "");
  }
  function renderHealth(h) {
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
  }

  async function loadTickets(keepSel) {
    try {
      var res = await fetch("/api/tickets");
      var data = await res.json();
      state.tickets = data.tickets || [];
      renderList();
      if (keepSel && state.selected) {
        if (!state.tickets.some(function(t){ return t.id === state.selected; })) state.selected = null;
      }
    } catch (e) { /* transient */ }
  }
  async function loadHealth() {
    try {
      var res = await fetch("/api/health");
      renderHealth(await res.json());
    } catch (e) { /* transient */ }
  }

  // ---- admin: detail ----
  async function selectTicket(id) {
    state.selected = id;
    renderList();
    var d = document.getElementById("detail");
    d.innerHTML = "";
    d.appendChild(el("div", "empty", "Loading…"));
    try {
      var res = await fetch("/api/ticket?id=" + encodeURIComponent(id));
      if (!res.ok) { d.innerHTML = ""; d.appendChild(el("div","empty","Could not load ticket.")); return; }
      var data = await res.json();
      renderDetail(data.ticket, data.arnie);
    } catch (e) {
      d.innerHTML = ""; d.appendChild(el("div","empty","Error loading ticket."));
    }
  }

  function renderDetail(t, arnie) {
    var d = document.getElementById("detail");
    d.innerHTML = "";
    var tr = t.triage || {};

    var dh = el("div", "dh");
    dh.appendChild(el("h2", null, t.subject || "(no subject)"));
    dh.appendChild(tierChip(t.tier || tr.tier));
    if (tr.priority) dh.appendChild(el("span", "chip", tr.priority));
    dh.appendChild(el("span", "chip st-" + t.status, t.status));
    d.appendChild(dh);
    d.appendChild(el("div", "meta", t.id + " · " + (t.channel || "") + " · from " + (t.from || "") + " · created " + ago(t.created_at) + " · updated " + ago(t.updated_at)));

    // Actions (full control)
    d.appendChild(el("div", "sec", "Actions"));
    var actions = el("div", "actions");
    var closeBtn = el("button", "btn warn", t.status === "closed" ? "Reopen" : "Close");
    closeBtn.onclick = function(){ doAction(t.status === "closed" ? "reopen" : "close", { id: t.id }, t.id); };
    actions.appendChild(closeBtn);
    var redo = el("button", "btn", "Re-dispatch to Arnie");
    redo.onclick = function(){ doAction("redispatch", { id: t.id }, t.id); };
    actions.appendChild(redo);
    d.appendChild(actions);

    var rb = el("div", "replybox");
    var ta = el("textarea"); ta.placeholder = "Reply as Casey…";
    var sb = el("button", "btn primary", "Send reply");
    sb.onclick = async function(){
      var text = ta.value.trim();
      if (!text) return;
      sb.disabled = true;
      var r = await doAction("reply", { id: t.id, text: text }, t.id, true);
      sb.disabled = false;
      if (r) { ta.value = ""; if (r.note) toast(r.note); }
    };
    rb.appendChild(ta); rb.appendChild(sb);
    d.appendChild(rb);

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
  document.getElementById("refresh").onclick = function(){ loadTickets(true); loadHealth(); };

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

  // ---- boot + auto-refresh ----
  setView("admin");
  loadTickets(false);
  loadHealth();
  setInterval(function(){
    if (state.view === "admin") { loadTickets(true); loadHealth(); if (state.selected) selectTicket(state.selected); }
  }, 5000);
</script>
</body>
</html>`;
