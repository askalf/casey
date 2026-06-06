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
import { SlackChannel } from "./channels/slack.js";
import { DiscordChannel } from "./channels/discord.js";
import { TeamsChannel } from "./channels/teams.js";
import { SmsChannel } from "./channels/sms.js";
import { VoiceChannel } from "./channels/voice.js";
import { HttpServer } from "./server.js";
import { registerConsole } from "./console.js";
import type { Channel, InboundMessage } from "./channels/types.js";

const VERSION = "0.1.1";

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
  closed: chalk.dim("CLOSED"),
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

  if (config.slack) {
    const token = process.env.SLACK_BOT_TOKEN;
    const secret = process.env.SLACK_SIGNING_SECRET;
    if (token && secret) {
      channels.push(new SlackChannel(token, secret));
      console.log(chalk.dim(`  slack: POST /slack/events`));
    } else {
      console.error(chalk.red("  slack: --slack set but SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET missing — skipping"));
    }
  }

  if (config.discord) {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (token) {
      channels.push(new DiscordChannel(token));
      console.log(chalk.dim(`  discord: gateway bot`));
    } else {
      console.error(chalk.red("  discord: --discord set but DISCORD_BOT_TOKEN missing — skipping"));
    }
  }

  if (config.teams) {
    const id = process.env.TEAMS_APP_ID;
    const pass = process.env.TEAMS_APP_PASSWORD;
    if (id && pass) {
      channels.push(new TeamsChannel(id, pass));
      console.log(chalk.dim(`  teams: POST /teams/messages`));
    } else {
      console.error(chalk.red("  teams: --teams set but TEAMS_APP_ID / TEAMS_APP_PASSWORD missing — skipping"));
    }
  }

  const twilioBase = process.env.TWILIO_PUBLIC_BASE;
  if (config.sms) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const tok = process.env.TWILIO_AUTH_TOKEN;
    const num = process.env.TWILIO_NUMBER;
    if (sid && tok && num) {
      channels.push(new SmsChannel(sid, tok, num, twilioBase));
      console.log(chalk.dim(`  sms:   POST /sms`));
    } else {
      console.error(chalk.red("  sms: --sms set but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_NUMBER missing — skipping"));
    }
  }

  if (config.voice) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const tok = process.env.TWILIO_AUTH_TOKEN;
    if (sid && tok) {
      channels.push(new VoiceChannel(tok, twilioBase));
      console.log(chalk.dim(`  voice: POST /voice (spoken support line)`));
    } else {
      console.error(chalk.red("  voice: --voice set but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing — skipping"));
    }
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
  const connChannels = channels.filter((c) => c.kind === "connection");

  // Push channels (web/webhook/slack/teams) register routes on a shared HTTP server.
  // Each manages its own reply: web returns it in the HTTP response; slack/teams ack
  // fast then reply via their API — so the pipeline is passed straight through.
  let server: HttpServer | undefined;
  if (pushChannels.length) {
    server = new HttpServer();
    for (const ch of pushChannels) ch.register?.(server, (m) => handleInbound(deps, m));

    // Operator console (single pane: User chat + Admin/Dev cockpit) on the same server.
    const byName = new Map(channels.map((c) => [c.name, c]));
    registerConsole(server, {
      ticketStore: config.ticketStore,
      arnieQueue: config.arnieQueue,
      darioUrl: config.dario ? config.baseUrl ?? "http://localhost:3456" : config.baseUrl,
      deliver: async (ticket, text) => {
        const ch = byName.get(ticket.channel);
        if (!ch) return;
        await ch.reply({
          channel: ticket.channel,
          conversationId: ticket.conversationId,
          to: ticket.from,
          subject: ticket.subject,
          text,
          ref: ticket.ref,
        });
      },
    });
    console.log(chalk.dim(`  console: http://127.0.0.1:${config.port}/console (admin/dev + user)`));

    await server.start(config.port);
  }

  // Connection channels (the Discord gateway) open their own long-lived connection.
  for (const ch of connChannels) await ch.listen?.((m) => handleInbound(deps, m));

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

  for (const ch of channels) {
    try {
      await ch.stop?.();
    } catch {
      /* ignore shutdown errors */
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
