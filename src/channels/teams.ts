import type {
  Channel,
  ChannelServer,
  InboundHandler,
  OutboundMessage,
  ServerRequest,
  ServerResponse,
} from "./types.js";

const LOGIN = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";

/**
 * Microsoft Teams — a push channel via the Bot Framework. Teams POSTs "activities"
 * to /teams/messages; we ack fast, triage asynchronously, and reply by calling back
 * to the activity's serviceUrl with an app-credentials bearer token.
 *
 * Setup: register an Azure Bot (or Bot Framework) app, add the Teams channel, and
 * set the messaging endpoint to https://<host>/teams/messages.
 *   env: TEAMS_APP_ID, TEAMS_APP_PASSWORD
 *
 * NOTE: inbound Bot Framework JWT verification is a hardening TODO — keep this
 * endpoint behind the proxy / restrict it until that's added.
 */
export class TeamsChannel implements Channel {
  readonly name = "teams";
  readonly kind = "push" as const;
  private token?: { value: string; expiresAt: number };

  constructor(
    private appId: string,
    private appPassword: string,
  ) {}

  register(server: ChannelServer, handle: InboundHandler): void {
    server.route("POST", "/teams/messages", (req) => this.onActivity(req, handle));
  }

  private async onActivity(req: ServerRequest, handle: InboundHandler): Promise<ServerResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let activity: any;
    try {
      activity = JSON.parse(req.body || "{}");
    } catch {
      return { status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "invalid JSON" }) };
    }

    const text = String(activity.text ?? "").trim();
    if (activity.type === "message" && text) {
      const convId = String(activity.conversation?.id ?? "");
      const msg = {
        channel: "teams",
        conversationId: `teams:${convId}`,
        from: String(activity.from?.id ?? "unknown"),
        displayName: typeof activity.from?.name === "string" ? activity.from.name : undefined,
        text,
        ref: String(activity.id ?? ""),
        meta: { serviceUrl: String(activity.serviceUrl ?? ""), conversationId: convId },
      };
      void handle(msg)
        .then((out) => (out ? this.reply(out) : undefined))
        .catch((e) => console.error(`teams: handle failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    // Ack quickly; the reply goes back out-of-band via the connector.
    return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now + 60_000) return this.token.value;
    const res = await fetch(LOGIN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.appId,
        client_secret: this.appPassword,
        scope: "https://api.botframework.com/.default",
      }).toString(),
    });
    if (!res.ok) throw new Error(`teams token failed: ${res.status}`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: data.access_token, expiresAt: now + data.expires_in * 1000 };
    return data.access_token;
  }

  async reply(out: OutboundMessage): Promise<void> {
    const serviceUrl = (out.meta?.serviceUrl as string | undefined) ?? "";
    const convId = (out.meta?.conversationId as string | undefined) ?? out.conversationId.split(":").slice(1).join(":");
    if (!serviceUrl) throw new Error("teams reply: missing serviceUrl");
    const token = await this.getToken();
    const url = `${serviceUrl.replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(convId)}/activities`;
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "message", text: out.text }),
    });
    if (!res.ok) throw new Error(`teams reply failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
}
