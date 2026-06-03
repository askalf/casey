import type Anthropic from "@anthropic-ai/sdk";
import fsp from "node:fs/promises";
import path from "node:path";

import { triage, type TriageResult } from "./triage.js";
import { troubleshoot } from "./troubleshoot.js";
import {
  newTicket,
  addTurn,
  saveTicket,
  findOpenByConversation,
  conversationText,
  type Ticket,
} from "./ticket.js";
import type { InboundMessage, OutboundMessage } from "./channels/types.js";

export interface PipelineDeps {
  client: Anthropic;
  model: string;
  ticketStore: string;
  /** When set, Tier-3 escalations are dropped into <arnieQueue>/inbox as arnie task files. */
  arnieQueue?: string;
  log?: (line: string) => void;
}

/** Drop a Tier-3 hand-off into arnie's --serve queue. */
async function routeToArnie(arnieQueue: string | undefined, ticket: Ticket, brief: string): Promise<string | null> {
  if (!arnieQueue) return null;
  const inbox = path.join(arnieQueue, "inbox");
  await fsp.mkdir(inbox, { recursive: true }).catch(() => {});
  const file = path.join(inbox, `${ticket.id}.task`);
  const task = `[escalated by Casey — ticket ${ticket.id}, ${ticket.channel} ${ticket.from}]\n\n${brief}`;
  await fsp.writeFile(file, task, "utf8");
  return file;
}

function outbound(msg: InboundMessage, text: string): OutboundMessage {
  return {
    channel: msg.channel,
    conversationId: msg.conversationId,
    to: msg.from,
    subject: msg.subject,
    text,
    ref: msg.ref,
  };
}

/**
 * Tier-2 step. Works for both the opening step (empty exchange) and continuations:
 * the ticket body is the original problem, and everything in the thread after it is
 * the back-and-forth. Resolves, asks the next question, or escalates to arnie.
 */
async function stepTroubleshoot(deps: PipelineDeps, ticket: Ticket, msg: InboundMessage): Promise<OutboundMessage> {
  const exchange = ticket.thread.slice(1).map((t) => ({ role: t.role, text: t.text }));
  const step = await troubleshoot(
    deps.client,
    deps.model,
    { from: ticket.from, subject: ticket.subject, body: ticket.body },
    exchange,
  );
  addTurn(ticket, "casey", step.client_reply);
  if (step.status === "escalate") {
    const routed = await routeToArnie(deps.arnieQueue, ticket, step.escalation_brief || step.internal_note || ticket.subject);
    ticket.status = "escalated";
    ticket.routed_to = routed ?? undefined;
    deps.log?.(`[${ticket.id}] Tier-2 → escalated to arnie${routed ? ` (${path.basename(routed)})` : ""}`);
  } else {
    ticket.status = step.status === "resolved" ? "resolved" : "troubleshooting";
    deps.log?.(`[${ticket.id}] Tier-2 ${step.status}`);
  }
  await saveTicket(deps.ticketStore, ticket);
  return outbound(msg, step.client_reply);
}

/**
 * Apply a Tier-1 triage result, routing by the chosen action:
 *   escalate → Tier-3 (arnie), troubleshoot → Tier-2, resolve/ask_client → Tier-1.
 */
async function applyTriage(deps: PipelineDeps, ticket: Ticket, msg: InboundMessage, t: TriageResult): Promise<OutboundMessage> {
  ticket.triage = t;
  ticket.tier = t.tier;

  if (t.action === "escalate") {
    addTurn(ticket, "casey", t.client_reply);
    const routed = await routeToArnie(deps.arnieQueue, ticket, t.escalation_brief || t.summary);
    ticket.status = "escalated";
    ticket.routed_to = routed ?? undefined;
    deps.log?.(`[${ticket.id}] ${msg.channel} ${t.category}/${t.priority}/T3 → arnie${routed ? ` (${path.basename(routed)})` : ""}`);
    await saveTicket(deps.ticketStore, ticket);
    return outbound(msg, t.client_reply);
  }

  if (t.action === "troubleshoot") {
    deps.log?.(`[${ticket.id}] ${msg.channel} ${t.category}/${t.priority}/T2 → troubleshooting`);
    return stepTroubleshoot(deps, ticket, msg);
  }

  // Tier-1 — resolve or ask the client.
  addTurn(ticket, "casey", t.client_reply);
  ticket.status = t.action === "ask_client" ? "awaiting_client" : "resolved";
  deps.log?.(`[${ticket.id}] ${msg.channel} ${t.category}/${t.priority}/T1 → ${t.action}`);
  await saveTicket(deps.ticketStore, ticket);
  return outbound(msg, t.client_reply);
}

/**
 * The omnichannel core. Takes one inbound message from any channel, advances its
 * ticket through Tier-1 triage → Tier-2 guided troubleshooting → Tier-3 escalation,
 * persists the conversation, and returns the reply to send back out (or null to stay
 * silent). Channel adapters call this and route the result back through their medium.
 */
export async function handleInbound(deps: PipelineDeps, msg: InboundMessage): Promise<OutboundMessage | null> {
  if (!msg.text.trim()) return null;

  const existing = await findOpenByConversation(deps.ticketStore, msg.conversationId);
  if (existing) {
    existing.ref = msg.ref ?? existing.ref;
    addTurn(existing, "client", msg.text);

    if (existing.status === "troubleshooting") {
      return stepTroubleshoot(deps, existing, msg);
    }
    // Reply to a Tier-1 "awaiting_client" ask — re-triage with the full conversation
    // so new detail can resolve it, deepen it to Tier-2, or escalate.
    const t = await triage(deps.client, deps.model, {
      from: existing.from,
      subject: existing.subject,
      body: conversationText(existing),
    });
    return applyTriage(deps, existing, msg, t);
  }

  // New conversation.
  const ticket = newTicket({
    channel: msg.channel,
    conversationId: msg.conversationId,
    from: msg.from,
    subject: msg.subject ?? "(no subject)",
    body: msg.text,
    ref: msg.ref,
  });
  const t = await triage(deps.client, deps.model, { from: ticket.from, subject: ticket.subject, body: ticket.body });
  return applyTriage(deps, ticket, msg, t);
}
