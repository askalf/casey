/**
 * Channel abstraction — every communication surface (email, web chat, Slack,
 * SMS, voice, …) implements this so the triage → troubleshoot → escalate
 * pipeline is identical regardless of where a ticket came in.
 *
 * Three kinds:
 *  - "poll"       channels pull new messages on a timer (e.g. email/IMAP) and ack them.
 *  - "push"       channels receive messages via the shared HTTP server (web widget,
 *                 webhook, Slack events, Teams, Twilio SMS/voice) and register routes.
 *  - "connection" channels hold a long-lived connection (e.g. the Discord gateway
 *                 WebSocket): listen() opens it and drives the handler itself.
 */

export interface InboundMessage {
  /** Adapter name: "email" | "web" | "webhook" | "slack" | "sms" | "voice" | … */
  channel: string;
  /** Stable id grouping a conversation/thread (email thread, chat session, phone #, slack thread). */
  conversationId: string;
  /** Sender identity in the channel's terms (email address, slack user id, phone number, web session). */
  from: string;
  displayName?: string;
  subject?: string;
  text: string;
  /** Channel-native handle used to reply into / ack this message (imap uid, slack ts, etc.). */
  ref?: string;
  /** Anything channel-specific the adapter needs to round-trip (set by the adapter, opaque to the core). */
  meta?: Record<string, unknown>;
}

export interface OutboundMessage {
  channel: string;
  conversationId: string;
  to: string;
  subject?: string;
  text: string;
  /** Thread/handle to reply into, carried over from the inbound message. */
  ref?: string;
  meta?: Record<string, unknown>;
}

/** Minimal HTTP surface a push channel registers routes against (backed by node:http). */
export interface ChannelServer {
  route(
    method: "GET" | "POST",
    path: string,
    handler: (req: ServerRequest) => Promise<ServerResponse>,
  ): void;
}

export interface ServerRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Raw request body (parse as JSON or form per the channel). */
  body: string;
}

export interface ServerResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

/** The core hands an inbound message to this and gets back the reply to send (or null to stay silent). */
export type InboundHandler = (msg: InboundMessage) => Promise<OutboundMessage | null>;

export interface Channel {
  readonly name: string;
  readonly kind: "poll" | "push" | "connection";

  /** Send a reply back out through this channel. */
  reply(out: OutboundMessage): Promise<void>;

  /** poll channels: pull new inbound messages. */
  receive?(): Promise<InboundMessage[]>;
  /** poll channels: mark messages handled (e.g. flag email seen) so they aren't re-fetched. */
  ack?(messages: InboundMessage[]): Promise<void>;

  /**
   * push channels: register HTTP routes on the shared server. The adapter parses
   * each request into an InboundMessage, calls `handle`, and either returns the
   * reply in the HTTP response (web) or acks fast and delivers the reply itself
   * via reply() (Slack/Teams, which require a quick ack then an async API call).
   */
  register?(server: ChannelServer, handle: InboundHandler): void;

  /**
   * connection channels: open a long-lived connection (e.g. the Discord gateway)
   * and drive `handle` on each inbound message, delivering replies via reply().
   * Resolves once the connection is established; runs until stop().
   */
  listen?(handle: InboundHandler): Promise<void>;

  /** Optional lifecycle hooks (open IMAP connection, validate creds, close sockets). */
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
