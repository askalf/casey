import fsp from "node:fs/promises";
import path from "node:path";
import type { TriageResult } from "./triage.js";

export interface Ticket {
  id: string;
  created_at: string;
  from: string;
  subject: string;
  body: string;
  status: "new" | "resolved" | "awaiting_client" | "escalated";
  triage?: TriageResult;
  routed_to?: string; // path of the arnie task file, when escalated
}

export interface IncomingTicket {
  from: string;
  subject: string;
  body: string;
}

export function newTicket(t: IncomingTicket): Ticket {
  return {
    id: `tkt_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    created_at: new Date().toISOString(),
    from: t.from,
    subject: t.subject,
    body: t.body,
    status: "new",
  };
}

export async function appendTicket(store: string, t: Ticket): Promise<void> {
  await fsp.mkdir(path.dirname(store), { recursive: true }).catch(() => {});
  await fsp.appendFile(store, JSON.stringify(t) + "\n", "utf8");
}

export async function loadTickets(store: string): Promise<Ticket[]> {
  try {
    const raw = await fsp.readFile(store, "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Ticket);
  } catch {
    return [];
  }
}

/**
 * Parse a ticket from file/stdin content: a JSON object {from,subject,body},
 * or a plain email with optional `From:` / `Subject:` headers then a blank line
 * then the body. Anything unrecognized is treated as the body.
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
