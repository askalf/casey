import type {
  Channel,
  ChannelServer,
  InboundHandler,
  OutboundMessage,
  ServerRequest,
  ServerResponse,
} from "./types.js";
import { WIDGET_HTML } from "./web-widget.js";

function json(status: number, body: unknown): ServerResponse {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

let counter = 0;

/**
 * Web + universal webhook — a push channel. Serves an embeddable chat widget at
 * GET / and answers it synchronously at POST /web (live chat: the reply comes back
 * in the HTTP response). POST /webhook is the universal intake: any system that can
 * speak HTTP (forms, Zapier, SMS gateways, custom apps) posts a message and gets the
 * reply back — no bespoke integration needed.
 */
export class WebChannel implements Channel {
  readonly name = "web";
  readonly kind = "push" as const;

  // Web is synchronous — the reply is returned in the HTTP response, so there's
  // nothing to push after the fact.
  async reply(_out: OutboundMessage): Promise<void> {}

  register(server: ChannelServer, handle: InboundHandler): void {
    server.route("GET", "/", async () => ({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: WIDGET_HTML,
    }));
    server.route("GET", "/health", async () => json(200, { ok: true, channel: "web" }));
    server.route("POST", "/web", (req) => this.handlePost(req, handle, "web"));
    server.route("POST", "/webhook", (req) => this.handlePost(req, handle, "webhook"));
  }

  private async handlePost(req: ServerRequest, handle: InboundHandler, mode: "web" | "webhook"): Promise<ServerResponse> {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(req.body || "{}") as Record<string, unknown>;
    } catch {
      return json(400, { error: "invalid JSON body" });
    }

    const text = String(payload.text ?? payload.message ?? "").trim();
    if (!text) return json(400, { error: "missing 'text'" });

    const channel = mode === "webhook" ? String(payload.channel ?? "webhook") : "web";
    const from = payload.from ? String(payload.from) : `${channel}:anon-${(counter++).toString(36)}`;
    const conversationId = String(payload.conversationId ?? payload.session ?? `${channel}:${from}`);

    const reply = await handle({
      channel,
      conversationId,
      from,
      displayName: payload.name ? String(payload.name) : undefined,
      subject: payload.subject ? String(payload.subject) : undefined,
      text,
    });

    return json(200, {
      conversationId,
      reply: reply?.text ?? "",
      status: reply ? "ok" : "ignored",
    });
  }
}
