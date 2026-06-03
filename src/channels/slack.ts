import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  Channel,
  ChannelServer,
  InboundHandler,
  OutboundMessage,
  ServerRequest,
  ServerResponse,
} from "./types.js";

function json(status: number, body: unknown): ServerResponse {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * Slack — a push channel via the Events API. Slack POSTs message events to
 * /slack/events; we verify the signing-secret signature, ack within Slack's 3s
 * window, then triage asynchronously and reply in-thread via chat.postMessage.
 *
 * Setup: create a Slack app, add a bot token (chat:write, app_mentions:read,
 * im:history/im:read or channels:history), subscribe to message events, and point
 * the Request URL at https://<host>/slack/events.
 *   env: SLACK_BOT_TOKEN (xoxb-…), SLACK_SIGNING_SECRET
 */
export class SlackChannel implements Channel {
  readonly name = "slack";
  readonly kind = "push" as const;
  private seen = new Set<string>(); // event_id dedupe (Slack retries on slow ack)

  constructor(
    private botToken: string,
    private signingSecret: string,
  ) {}

  register(server: ChannelServer, handle: InboundHandler): void {
    server.route("POST", "/slack/events", (req) => this.onEvent(req, handle));
  }

  private verify(req: ServerRequest): boolean {
    const ts = req.headers["x-slack-request-timestamp"];
    const sig = req.headers["x-slack-signature"];
    if (!ts || !sig) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false; // replay window
    const mine = "v0=" + createHmac("sha256", this.signingSecret).update(`v0:${ts}:${req.body}`).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(mine), Buffer.from(sig));
    } catch {
      return false; // length mismatch
    }
  }

  private async onEvent(req: ServerRequest, handle: InboundHandler): Promise<ServerResponse> {
    if (!this.verify(req)) return json(401, { error: "bad signature" });

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(req.body || "{}") as Record<string, unknown>;
    } catch {
      return json(400, { error: "invalid JSON" });
    }

    if (body.type === "url_verification") return json(200, { challenge: body.challenge });

    if (body.type === "event_callback") {
      const eventId = String(body.event_id ?? "");
      if (eventId && this.seen.has(eventId)) return json(200, { ok: true }); // duplicate retry
      if (eventId) this.seen.add(eventId);

      const ev = (body.event ?? {}) as Record<string, unknown>;
      const text = String(ev.text ?? "").trim();
      // Real human messages only — skip bot messages and edits/joins/etc. (subtype set).
      if (ev.type === "message" && !ev.bot_id && !ev.subtype && text) {
        const channel = String(ev.channel ?? "");
        const thread = String(ev.thread_ts ?? ev.ts ?? "");
        const msg = {
          channel: "slack",
          conversationId: `slack:${channel}:${thread}`,
          from: String(ev.user ?? "unknown"),
          text,
          ref: thread,
          meta: { channel },
        };
        // Ack now; process out of band (the LLM call exceeds Slack's 3s ack window).
        void handle(msg)
          .then((out) => (out ? this.reply(out) : undefined))
          .catch((e) => console.error(`slack: handle failed: ${e instanceof Error ? e.message : String(e)}`));
      }
      return json(200, { ok: true });
    }

    return json(200, { ok: true });
  }

  async reply(out: OutboundMessage): Promise<void> {
    const channel = (out.meta?.channel as string | undefined) ?? out.conversationId.split(":")[1];
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${this.botToken}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, thread_ts: out.ref || undefined, text: out.text }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!data.ok) throw new Error(`slack chat.postMessage failed: ${data.error ?? res.status}`);
  }
}
