import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { IncomingTicket } from "./ticket.js";

export const CATEGORIES = [
  "account_access",
  "email",
  "hardware",
  "software",
  "network",
  "printing",
  "security",
  "data",
  "performance",
  "how_to",
  "other",
] as const;
export const PRIORITIES = ["P1", "P2", "P3", "P4"] as const;
export const ACTIONS = ["resolve", "ask_client", "escalate"] as const;

export const triageSchema = z.object({
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES),
  tier: z.coerce.number().int().min(1).max(3),
  summary: z.string(),
  missing_info: z.array(z.string()).default([]),
  action: z.enum(ACTIONS),
  client_reply: z.string(),
  escalation_brief: z.string().optional(),
});
export type TriageResult = z.infer<typeof triageSchema>;

const SYSTEM = `You are Casey, the Tier-1 IT service-desk CSR for a managed IT support team. A client has emailed a support request. Triage it and decide what happens next.

Decide:
- category: the kind of issue.
- priority: P1 = business-down or an active security incident; P2 = major impact or many users affected; P3 = normal single-user issue; P4 = minor or a how-to question.
- action — choose exactly ONE:
  • "resolve" (tier 1) — you can fully solve it from the ticket alone: a how-to, a known fix, clear self-serve steps. Put the COMPLETE, friendly solution in client_reply.
  • "ask_client" (tier 1) — you genuinely need more information before anyone can act. List exactly what's missing in missing_info; client_reply asks for it warmly and specifically.
  • "escalate" (tier 3) — a real technical problem needing hands-on diagnosis or a fix on a system, not something the client can self-serve. client_reply acknowledges and sets expectations (no false promises); escalation_brief is a crisp technical task for the Tier-3 engineer ("arnie"): the symptom, the affected system/host, what's known, and what to investigate or try first.
- summary: one plain line describing the issue.

client_reply is the actual email you would send the client: warm, concise, professional; acknowledge the impact; one clear next step; no jargon they won't understand; never robotic. Sign off as "— Casey, IT Service Desk".

Be honest: don't promise a Tier-1 fix you can't deliver — escalate genuine technical problems; and don't escalate things the client can do themselves in a couple of steps — resolve those.

Respond with ONLY a single JSON object — no prose, no markdown code fences — exactly this shape:
{"category": "<one of: ${CATEGORIES.join(", ")}>", "priority": "<P1|P2|P3|P4>", "tier": <1|2|3>, "summary": "<one line>", "missing_info": ["<...>"], "action": "<resolve|ask_client|escalate>", "client_reply": "<the email to the client>", "escalation_brief": "<only when action is escalate>"}`;

function extractJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Triage one ticket into a structured decision. Uses JSON-in-text (not tool
 * calls) so it routes cleanly through dario, which reshapes the request and
 * doesn't preserve forced tool_choice. Retries once on an unparseable reply.
 */
export async function triage(client: Anthropic, model: string, ticket: IncomingTicket): Promise<TriageResult> {
  const base = `From: ${ticket.from}\nSubject: ${ticket.subject}\n\n${ticket.body}`;
  let lastErr = "unknown";
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = attempt === 0 ? base : `${base}\n\n(Your previous reply was not valid JSON. Respond with ONLY the JSON object, nothing else.)`;
    const msg = await client.messages.create({
      model,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const json = extractJson(text);
    if (json) {
      const parsed = triageSchema.safeParse(json);
      if (parsed.success) return parsed.data;
      lastErr = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    } else {
      lastErr = "no JSON object found in reply";
    }
  }
  throw new Error(`triage: could not parse a valid result (${lastErr})`);
}
