import http from "node:http";
import type { ChannelServer, ServerRequest, ServerResponse } from "./channels/types.js";

type Handler = (req: ServerRequest) => Promise<ServerResponse>;

/**
 * A tiny HTTP server that "push" channels register routes against (web widget,
 * universal webhook, and later Slack/Twilio webhooks). One server, many channels.
 */
export class HttpServer implements ChannelServer {
  private routes = new Map<string, Handler>();
  private server?: http.Server;

  route(method: "GET" | "POST", path: string, handler: Handler): void {
    this.routes.set(`${method} ${path}`, handler);
  }

  async start(port: number, host = "127.0.0.1"): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.dispatch(req, res).catch((e) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = (req.method ?? "GET").toUpperCase();
    const handler = this.routes.get(`${method} ${url.pathname}`);
    if (!handler) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const sreq: ServerRequest = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v ?? ""]),
      ),
      body,
    };
    const r = await handler(sreq);
    res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
    res.end(r.body);
  }
}
