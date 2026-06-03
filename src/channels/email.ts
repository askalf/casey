import type { Channel, InboundMessage, OutboundMessage } from "./types.js";
import { pollInbox, markSeen, sendReply, type EmailConfig, type FetchedEmail } from "../email.js";

/** Strip Re:/Fwd: and case so a reply threads onto the same conversation. */
function normalizeSubject(s: string): string {
  return s.replace(/^\s*(re|fwd?):\s*/i, "").trim().toLowerCase();
}

/** Heuristic email thread key: sender + normalized subject. */
export function emailConversationId(from: string, subject: string): string {
  return `email:${from.toLowerCase()}:${normalizeSubject(subject)}`;
}

/** Email as a poll channel — pulls unseen mail, acks (flags seen) only after handling. */
export class EmailChannel implements Channel {
  readonly name = "email";
  readonly kind = "poll" as const;

  constructor(private cfg: EmailConfig) {}

  async receive(): Promise<InboundMessage[]> {
    const emails = await pollInbox(this.cfg);
    return emails.map((em) => this.toInbound(em));
  }

  private toInbound(em: FetchedEmail): InboundMessage {
    return {
      channel: "email",
      conversationId: emailConversationId(em.from, em.subject),
      from: em.from,
      subject: em.subject,
      text: em.body,
      ref: em.messageId,
      meta: { uid: em.uid },
    };
  }

  async ack(messages: InboundMessage[]): Promise<void> {
    const uids = messages
      .map((m) => m.meta?.uid)
      .filter((u): u is number => typeof u === "number");
    if (uids.length) await markSeen(this.cfg, uids);
  }

  async reply(out: OutboundMessage): Promise<void> {
    await sendReply(this.cfg, {
      to: out.to,
      subject: out.subject ?? "(no subject)",
      body: out.text,
      inReplyTo: out.ref,
    });
  }
}
