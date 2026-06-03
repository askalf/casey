import { WebSocket } from "ws";
import type { Channel, InboundHandler, OutboundMessage } from "./types.js";

const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const API = "https://discord.com/api/v10";
// Gateway intents: GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT.
// MESSAGE_CONTENT is privileged — enable it in the bot's settings in the dev portal.
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

interface GatewayPayload {
  op: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  d: any;
  s: number | null;
  t: string | null;
}

/**
 * Discord — a connection channel over the gateway WebSocket. Listens for messages
 * (DMs + channels the bot can see), triages them, and replies via the REST API.
 *
 * Setup: create a Discord application + bot, enable the MESSAGE CONTENT intent,
 * invite the bot with the "Send Messages" + "Read Message History" permissions.
 *   env: DISCORD_BOT_TOKEN
 *
 * Minimal client: heartbeat + identify + MESSAGE_CREATE + basic reconnect (no
 * session resume — a brief disconnect just re-identifies fresh).
 */
export class DiscordChannel implements Channel {
  readonly name = "discord";
  readonly kind = "connection" as const;
  private ws?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private seq: number | null = null;
  private handle?: InboundHandler;
  private stopped = false;

  constructor(private botToken: string) {}

  async listen(handle: InboundHandler): Promise<void> {
    this.handle = handle;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(GATEWAY);
    this.ws = ws;
    ws.on("message", (raw: Buffer) => this.onMessage(raw.toString()));
    ws.on("close", () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (!this.stopped) setTimeout(() => this.connect(), 3000); // basic reconnect
    });
    ws.on("error", (e: Error) => console.error(`discord: ws error: ${e.message}`));
  }

  private send(op: number, d: unknown): void {
    this.ws?.send(JSON.stringify({ op, d }));
  }

  private onMessage(data: string): void {
    let p: GatewayPayload;
    try {
      p = JSON.parse(data) as GatewayPayload;
    } catch {
      return;
    }
    if (p.s !== null && p.s !== undefined) this.seq = p.s;

    switch (p.op) {
      case 10: {
        // HELLO — begin heartbeating, then identify.
        const interval = p.d.heartbeat_interval as number;
        this.heartbeat = setInterval(() => this.send(1, this.seq), interval);
        this.send(2, {
          token: this.botToken,
          intents: INTENTS,
          properties: { os: "linux", browser: "casey", device: "casey" },
        });
        break;
      }
      case 1: // server asked for a heartbeat
        this.send(1, this.seq);
        break;
      case 7: // RECONNECT
      case 9: // INVALID SESSION
        this.ws?.close();
        break;
      case 0: // DISPATCH
        if (p.t === "MESSAGE_CREATE") this.onChat(p.d);
        break;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onChat(d: any): void {
    if (!d || d.author?.bot) return; // ignore bots (including ourselves)
    const text = String(d.content ?? "").trim();
    if (!text) return; // empty (attachment-only, or the MESSAGE_CONTENT intent is off)
    const channelId = String(d.channel_id);
    const msg = {
      channel: "discord",
      conversationId: `discord:${channelId}`,
      from: d.author?.id ? `${d.author.username ?? "user"}#${d.author.id}` : "unknown",
      displayName: typeof d.author?.username === "string" ? d.author.username : undefined,
      text,
      ref: channelId,
      meta: { channelId },
    };
    void this.handle?.(msg)
      .then((out) => (out ? this.reply(out) : undefined))
      .catch((e) => console.error(`discord: handle failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  async reply(out: OutboundMessage): Promise<void> {
    const channelId = (out.meta?.channelId as string | undefined) ?? out.conversationId.split(":")[1];
    const res = await fetch(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${this.botToken}`, "content-type": "application/json" },
      body: JSON.stringify({ content: out.text.slice(0, 2000) }), // Discord's 2000-char limit
    });
    if (!res.ok) throw new Error(`discord send failed: ${res.status} ${await res.text().catch(() => "")}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }
}
