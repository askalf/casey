import fsp from "node:fs/promises";
import path from "node:path";
import type { TriageResult } from "./triage.js";

export type TicketStatus = "new" | "resolved" | "awaiting_client" | "troubleshooting" | "escalated" | "closed";

/** One turn of a ticket's conversation, oldest first. */
export interface ThreadTurn {
  role: "client" | "casey";
  text: string;
  at: string;
}

export interface Ticket {
  id: string;
  created_at: string;
  updated_at: string;
  /** Origin channel: "email" | "web" | "webhook" | "slack" | "sms" | "voice" | "cli". */
  channel: string;
  /** Stable key grouping this conversation, so a client's reply continues the same ticket. */
  conversationId: string;
  from: string;
  /** Channel-native handle to reply into the thread (imap message-id, slack ts, …). */
  ref?: string;
  subject: string;
  /** The opening message. */
  body: string;
  status: TicketStatus;
  tier?: number;
  triage?: TriageResult;
  /** Full conversation, oldest first (Tier-2 troubleshooting reads this). */
  thread: ThreadTurn[];
  /** Path of the arnie task file, when escalated to Tier-3. */
  routed_to?: string;
  /** T3 / discipline sign-off on an escalated (proposed) remediation. */
  approval?: { decision: "approved" | "rejected"; by: string; at: string; note?: string };
  /** MSP client + asset this ticket belongs to (set by CSR/Dispatch). */
  clientId?: string;
  assetId?: string;
  /** Staff member this ticket is assigned to (free-text until identity lands). */
  assignee?: string;
}

/** A bare inbound ticket — the minimum to triage. */
export interface IncomingTicket {
  from: string;
  subject: string;
  body: string;
}

export interface NewTicketInput {
  channel: string;
  conversationId: string;
  from: string;
  subject: string;
  body: string;
  ref?: string;
}

function uid(): string {
  return `tkt_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function newTicket(src: NewTicketInput): Ticket {
  const now = new Date().toISOString();
  return {
    id: uid(),
    created_at: now,
    updated_at: now,
    channel: src.channel,
    conversationId: src.conversationId,
    from: src.from,
    ref: src.ref,
    subject: src.subject,
    body: src.body,
    status: "new",
    thread: [{ role: "client", text: src.body, at: now }],
  };
}

export function addTurn(t: Ticket, role: "client" | "casey", text: string): void {
  const at = new Date().toISOString();
  t.thread.push({ role, text, at });
  t.updated_at = at;
}

/** The whole conversation rendered as text, for re-triaging a continued thread. */
export function conversationText(t: Ticket): string {
  return t.thread.map((turn) => `${turn.role === "client" ? "CLIENT" : "CASEY"}: ${turn.text}`).join("\n\n");
}

/**
 * Append the ticket's current state. loadTickets() dedupes by id keeping the last
 * write, so repeated saves act as an upsert (simple append-only JSONL, fine at
 * service-desk volume).
 */
export async function saveTicket(store: string, t: Ticket): Promise<void> {
  await fsp.mkdir(path.dirname(store), { recursive: true }).catch(() => {});
  await fsp.appendFile(store, JSON.stringify(t) + "\n", "utf8");
}

export async function loadTickets(store: string): Promise<Ticket[]> {
  try {
    const raw = await fsp.readFile(store, "utf8");
    const byId = new Map<string, Ticket>();
    for (const line of raw.trim().split("\n").filter(Boolean)) {
      try {
        const t = JSON.parse(line) as Ticket;
        byId.set(t.id, t); // last write wins
      } catch {
        /* skip a corrupt line */
      }
    }
    return [...byId.values()];
  } catch {
    return [];
  }
}

const OPEN_STATUSES: TicketStatus[] = ["new", "awaiting_client", "troubleshooting"];

/** The latest still-open ticket for a conversation, so a reply continues its thread. */
export async function findOpenByConversation(store: string, conversationId: string): Promise<Ticket | null> {
  const open = (await loadTickets(store))
    .filter((t) => t.conversationId === conversationId && OPEN_STATUSES.includes(t.status))
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  return open.length ? open[open.length - 1] : null;
}

/**
 * Parse a ticket from file/stdin content: a JSON object {from,subject,body}, or a
 * plain email with optional `From:` / `Subject:` headers then a blank line then the
 * body. Anything unrecognized is treated as the body.
 */
export function parseTicket(content: string, fallbackFrom = "client@unknown"): IncomingTicket {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed) as Record<string, string>;
      return {
        from: j.from ?? fallbackFrom,
        subject: j.subject ?? "(no subject)",
        body: j.body ?? j.text ?? "",
      };
    } catch {
      /* not JSON — fall through to header parsing */
    }
  }
  let from = fallbackFrom;
  let subject = "(no subject)";
  const lines = content.split(/\r?\n/);
  let bodyStart = 0;
  let sawHeader = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      if (sawHeader) {
        bodyStart = i + 1;
      }
      break;
    }
    const m = line.match(/^(From|Subject):\s*(.*)$/i);
    if (m) {
      sawHeader = true;
      if (/^from$/i.test(m[1])) from = m[2].trim();
      else subject = m[2].trim();
    } else {
      break; // first non-header line — no headers, treat whole thing as body
    }
  }
  const body = (sawHeader ? lines.slice(bodyStart).join("\n") : content).trim();
  return { from, subject, body };
}
