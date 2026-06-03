import fsp from "node:fs/promises";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { z } from "zod";
import type { IncomingTicket } from "./ticket.js";

export const emailConfigSchema = z.object({
  imap: z.object({
    host: z.string(),
    port: z.number().default(993),
    secure: z.boolean().default(true),
    user: z.string(),
    pass: z.string(),
  }),
  smtp: z.object({
    host: z.string(),
    port: z.number().default(465),
    secure: z.boolean().default(true),
    user: z.string(),
    pass: z.string(),
  }),
  from: z.string(), // reply From, e.g. "IT Service Desk <support@yourco.com>"
  mailbox: z.string().default("INBOX"),
});
export type EmailConfig = z.infer<typeof emailConfigSchema>;

export interface FetchedEmail extends IncomingTicket {
  uid: number;
  messageId?: string;
}

export const SAMPLE_EMAIL_CONFIG = JSON.stringify(
  {
    imap: { host: "imap.gmail.com", port: 993, secure: true, user: "support@yourco.com", pass: "<app-password>" },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true, user: "support@yourco.com", pass: "<app-password>" },
    from: "IT Service Desk <support@yourco.com>",
    mailbox: "INBOX",
  },
  null,
  2,
);

export async function loadEmailConfig(path: string): Promise<EmailConfig> {
  const raw = await fsp.readFile(path, "utf8");
  return emailConfigSchema.parse(JSON.parse(raw));
}

function imap(cfg: EmailConfig): ImapFlow {
  return new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: cfg.imap.secure,
    auth: { user: cfg.imap.user, pass: cfg.imap.pass },
    logger: false,
  });
}

/** Fetch unseen mail as tickets. Does NOT mark seen — call markSeen() after a
 * ticket is successfully handled, so a transient failure is retried next poll. */
export async function pollInbox(cfg: EmailConfig): Promise<FetchedEmail[]> {
  const client = imap(cfg);
  const out: FetchedEmail[] = [];
  await client.connect();
  const lock = await client.getMailboxLock(cfg.mailbox);
  try {
    const uids = await client.search({ seen: false }, { uid: true });
    if (uids && uids.length) {
      for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
        if (!msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const bodyText = typeof parsed.text === "string" ? parsed.text : "";
        out.push({
          uid: msg.uid,
          messageId: parsed.messageId,
          from: parsed.from?.value?.[0]?.address ?? parsed.from?.text ?? "unknown",
          subject: parsed.subject ?? "(no subject)",
          body: bodyText.trim(),
        });
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return out;
}

export async function markSeen(cfg: EmailConfig, uids: number[]): Promise<void> {
  if (uids.length === 0) return;
  const client = imap(cfg);
  await client.connect();
  const lock = await client.getMailboxLock(cfg.mailbox);
  try {
    await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
  } finally {
    lock.release();
    await client.logout();
  }
}

export async function sendReply(
  cfg: EmailConfig,
  opts: { to: string; subject: string; body: string; inReplyTo?: string },
): Promise<void> {
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
  });
  const subject = /^re:/i.test(opts.subject) ? opts.subject : `Re: ${opts.subject}`;
  await transport.sendMail({
    from: cfg.from,
    to: opts.to,
    subject,
    text: opts.body,
    inReplyTo: opts.inReplyTo,
    references: opts.inReplyTo,
  });
}
