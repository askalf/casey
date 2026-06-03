#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import process from "node:process";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { parseArgs, HELP, type Config } from "./config.js";
import { parseTicket, loadTickets, type Ticket, type TicketStatus } from "./ticket.js";
import { handleInbound, type PipelineDeps } from "./pipeline.js";
import { loadEmailConfig, SAMPLE_EMAIL_CONFIG } from "./email.js";
import { EmailChannel } from "./channels/email.js";
import { WebChannel } from "./channels/web.js";
import { HttpServer } from "./server.js";
import type { Channel, InboundMessage } from "./channels/types.js";

const VERSION = "0.1.0";

function makeClient(config: Config): Anthropic {
  if (config.dario) {
    if (!config.baseUrl) config.baseUrl = "http://localhost:3456";
    if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = "dario";
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(chalk.red("error: ANTHROPIC_API_KEY is not set"));
    console.error(chalk.dim("set a key, or run with --dario to route through a local dario proxy"));
    process.exit(1);
  }
  const opts: ConstructorParameters<typeof Anthropic>[0] = { maxRetries: 3 };
  if (config.baseUrl) opts.baseURL = config.baseUrl;
  return new Anthropic(opts);
}

function makeDeps(config: Config, client: Anthropic): PipelineDeps {
  return {
    client,
    model: config.model,
    ticketStore: config.ticketStore,
    arnieQueue: config.arnieQueue,
    log: (line) => console.log(chalk.dim(line)),
  };
}

const TIER_COLOR: Record<number, (s: string) => string> = { 1: chalk.green, 2: chalk.yellow, 3: chalk.red };
const STATUS_LABEL: Record<TicketStatus, string> = {
  new: chalk.dim("new"),
  resolved: chalk.green("RESOLVED (Tier-1)"),
  awaiting_client: chalk.yellow("AWAITING CLIENT (Tier-1)"),
  troubleshooting: chalk.yellow("TROUBLESHOOTING (Tier-2)"),
  escalated: chalk.red("ESCALATED → arnie (Tier-3)"),
};

function indent(s: string): string {
  return s.split("\n").map((l) => "  " + l).join("\n");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdTriage(config: Config, args: string[]): Promise<void> {
  const src = args[0];
  if (!src) {
    console.error(chalk.red("usage: casey triage <file|->"));
    process.exit(2);
  }
  const content = src === "-" ? await readStdin() : await fsp.readFile(src, "utf8");
  const incoming = parseTicket(content);
  const conversationId = `cli:${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const msg: InboundMessage = {
    channel: "cli",
    conversationId,
    from: incoming.from,
    subject: incoming.subject,
    text: incoming.body,
  };
  console.log(chalk.dim(`ticket from ${incoming.from} — "${incoming.subject}"`));

  const client = makeClient(config);
  const out = await handleInbound(makeDeps(config, client), msg);

  const ticket = (await loadTickets(config.ticketStore)).find((t) => t.conversationId === conversationId);
  if (ticket?.triage) {
    const t = ticket.triage;
    const tc = TIER_COLOR[t.tier] ?? chalk.white;
    console.log(chalk.bold("\nTriage"));
    console.log(`  category : ${t.category}`);
    console.log(`  priority : ${t.priority}`);
    console.log(`  tier     : ${tc(`T${t.tier}`)}`);
    console.log(`  summary  : ${t.summary}`);
  }
  console.log(chalk.bold("\nOutcome  ") + (ticket ? STATUS_LABEL[ticket.status] : "?"));
  if (out) {
    console.log(chalk.dim("  ┄┄┄"));
    console.log(chalk.cyan(indent(out.text)));
    console.log(chalk.dim("  ┄┄┄"));
  }
  if (ticket?.routed_to) console.log(chalk.cyan(`\n→ routed to arnie: ${ticket.routed_to}`));
  console.log(chalk.dim(`\nlogged → ${config.ticketStore}`));
}

/** Assemble the enabled channels for `serve`. */
async function buildChannels(config: Config): Promise<Channel[]> {
  const channels: Channel[] = [];

  const cfgPath = config.emailConfig ?? path.join(os.homedir(), ".casey", "email.json");
  try {
    const email = await loadEmailConfig(cfgPath);
    channels.push(new EmailChannel(email));
    console.log(chalk.dim(`  email: ${email.imap.user} (${email.mailbox}), poll ${config.serveInterval}s`));
  } catch (e) {
    if (config.emailConfig) {
      // Explicitly pointed at a config that failed to load — that's an error.
      console.error(chalk.red(`  email: couldn't load ${cfgPath}: ${e instanceof Error ? e.message : String(e)}`));
    }
    // Otherwise email just isn't configured — skip it silently.
  }

  if (config.web) {
    channels.push(new WebChannel());
    console.log(chalk.dim(`  web:   http://127.0.0.1:${config.port}/ (chat widget) + POST /webhook (universal)`));
  }

  return channels;
}

async function cmdServe(config: Config): Promise<void> {
  const client = makeClient(config);
  const deps = makeDeps(config, client);
  console.log(chalk.dim("serve: starting service desk — Ctrl+C to stop"));

  const channels = await buildChannels(config);
  if (!channels.length) {
    console.error(chalk.red("serve: no channels enabled. Configure email (~/.casey/email.json) or pass --web."));
    process.exit(1);
  }
  if (config.arnieQueue) console.log(chalk.dim(`  Tier-3 escalations → ${path.join(config.arnieQueue, "inbox")}`));

  const pushChannels = channels.filter((c) => c.kind === "push");
  const pollChannels = channels.filter((c) => c.kind === "poll");

  let server: HttpServer | undefined;
  if (pushChannels.length) {
    server = new HttpServer();
    for (const ch of pushChannels) {
      ch.register?.(server, async (m) => {
        console.log(chalk.cyan(`\n[${m.channel}] ${m.from}${m.subject ? ` — "${m.subject}"` : ""}`));
        const out = await handleInbound(deps, m);
        // Async push channels (e.g. Slack) deliver via reply(); synchronous ones
        // (web/webhook) return the reply in the HTTP response, so reply() is a no-op.
        if (out) await ch.reply(out);
        return out;
      });
    }
    await server.start(config.port);
  }

  let stop = false;
  let resolveStop: () => void = () => {};
  const stopPromise = new Promise<void>((r) => (resolveStop = r));
  process.on("SIGINT", () => {
    if (!stop) {
      stop = true;
      console.log(chalk.dim("\nserve: stopping…"));
      resolveStop();
    }
  });

  if (pollChannels.length === 0) {
    await stopPromise; // push-only: idle until Ctrl+C
  } else {
    while (!stop) {
      for (const ch of pollChannels) {
        if (stop) break;
        let msgs: InboundMessage[] = [];
        try {
          msgs = (await ch.receive?.()) ?? [];
        } catch (e) {
          console.error(chalk.red(`  ${ch.name} poll failed: ${e instanceof Error ? e.message : String(e)}`));
        }
        const handled: InboundMessage[] = [];
        for (const m of msgs) {
          if (stop) break;
          console.log(chalk.cyan(`\n[${ch.name}] ${m.from} — "${m.subject ?? ""}"`));
          try {
            const out = await handleInbound(deps, m);
            if (out) {
              await ch.reply(out);
              console.log(chalk.dim(`  replied to ${m.from}`));
            }
            handled.push(m);
          } catch (e) {
            console.error(chalk.red(`  failed: ${e instanceof Error ? e.message : String(e)} — leaving for retry`));
          }
        }
        if (handled.length) {
          try {
            await ch.ack?.(handled);
          } catch (e) {
            console.error(chalk.red(`  ${ch.name} ack failed: ${e instanceof Error ? e.message : String(e)}`));
          }
        }
      }
      if (stop) break;
      await Promise.race([new Promise((r) => setTimeout(r, config.serveInterval * 1000)), stopPromise]);
    }
  }

  if (server) await server.stop();
  console.log(chalk.dim("serve: stopped"));
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(chalk.red(`error: ${e instanceof Error ? e.message : String(e)}`));
    process.exit(2);
  }
  const { config, command, args } = parsed;
  if (config.showVersion) {
    console.log(`casey v${VERSION}`);
    return;
  }
  if (config.showHelp || !command) {
    console.log(HELP);
    return;
  }
  switch (command) {
    case "triage":
      await cmdTriage(config, args);
      break;
    case "serve":
      await cmdServe(config);
      break;
    case "email-config":
      console.log(SAMPLE_EMAIL_CONFIG);
      console.error(chalk.dim(`\n# save as ${path.join(os.homedir(), ".casey", "email.json")} (or pass --email-config <path>)`));
      break;
    default:
      console.error(chalk.red(`unknown command: ${command}`));
      console.log(HELP);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(chalk.red("fatal:"), e);
  process.exit(1);
});
