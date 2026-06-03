import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { completeJson } from "./llm.js";

/**
 * Tier-2 — guided remote troubleshooting. Where Tier-1 triage decides *what kind*
 * of ticket this is, Tier-2 actually works the problem with the client over a
 * multi-turn conversation, then resolves it or escalates to Tier-3 (arnie) with a
 * brief of everything tried and ruled out.
 */

export const TS_STATUS = ["troubleshooting", "resolved", "escalate"] as const;
export type TroubleshootStatus = (typeof TS_STATUS)[number];

export const troubleshootSchema = z.object({
  /** troubleshooting = need the client to do/answer something; resolved = fixed; escalate = needs hands-on Tier-3. */
  status: z.enum(TS_STATUS),
  /** The message to send the client this turn. */
  client_reply: z.string(),
  /** Private note: what was concluded / ruled out this turn (logged, never sent to the client). */
  internal_note: z.string().default(""),
  /** Only when status === "escalate": the technical handoff for the Tier-3 engineer (arnie). */
  escalation_brief: z.string().optional(),
});
export type TroubleshootStep = z.infer<typeof troubleshootSchema>;

/** One turn of the troubleshooting conversation. */
export interface ThreadTurn {
  role: "client" | "casey";
  text: string;
}

const SYSTEM = `You are Casey, the Tier-2 IT support engineer on a managed IT support team. Tier-1 triage has decided this ticket needs guided troubleshooting — deeper than a canned answer, but not yet hands-on system access. You work the problem WITH the client over a back-and-forth conversation: ask focused diagnostic questions, give precise steps to try, interpret what comes back, and converge on a fix.

Each turn, choose a status:
- "troubleshooting": you need the client to do or tell you something. client_reply gives ONE clearly-explained diagnostic step or question (at most two) — specific, numbered, easy for a non-technical person to follow. Briefly say why you're asking.
- "resolved": the issue is fixed, or you've given a fix you're confident resolves it. client_reply confirms what was wrong, the fix, and a one-line tip to prevent recurrence; warm close.
- "escalate": you've ruled out what the client can safely do remotely and it now needs hands-on system access (server-side, network gear, admin actions a normal user can't perform). client_reply tells the client you're handing it to the engineering team with a clear next step; escalation_brief is a crisp technical handoff for the Tier-3 engineer — the symptom, everything tried and the result of each, what's been ruled out, the current hypothesis, and what needs hands-on investigation.

Rules:
- One clear ask per turn — never dump a long checklist on the client.
- Don't loop forever: if ~3-4 exchanges haven't converged, escalate with a thorough brief rather than keep asking.
- Never ask the client to do anything risky or beyond a normal user (no registry edits, no admin/elevated commands, nothing that could lose data). If that's what the fix needs, escalate instead.
- Be warm, competent, and concise. Sign client replies "— Casey, IT Support".

Respond with ONLY a single JSON object — no prose, no code fences:
{"status":"<troubleshooting|resolved|escalate>","client_reply":"<the message to the client>","internal_note":"<what you concluded or ruled out this turn>","escalation_brief":"<include ONLY when status is escalate>"}`;

export interface TicketContext {
  from: string;
  subject: string;
  body: string;
}

/**
 * Produce the next troubleshooting step given the original ticket and the
 * conversation so far. Pass an empty `thread` for the opening step.
 */
export async function troubleshoot(
  client: Anthropic,
  model: string,
  ticket: TicketContext,
  thread: ThreadTurn[],
): Promise<TroubleshootStep> {
  const convo = thread.length
    ? thread.map((t) => `${t.role === "client" ? "CLIENT" : "CASEY"}: ${t.text}`).join("\n\n")
    : "(none yet — produce the opening troubleshooting step)";
  const userContent = `Ticket — from ${ticket.from}\nSubject: ${ticket.subject}\n\n${ticket.body}\n\n--- conversation so far ---\n${convo}`;
  return completeJson(client, model, SYSTEM, userContent, troubleshootSchema);
}
