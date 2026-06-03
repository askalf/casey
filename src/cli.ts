#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import process from "node:process";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { parseArgs, HELP, type Config } from "./config.js";
import { triage, type TriageResult } from "./triage.js";
import { newTicket, appendTicket, parseTicket, type Ticket } from "./ticket.js";
import { pollInbox, markSeen, sendReply, loadEmailConfig, SAMPLE_EMAIL_CONFIG, type EmailConfig, type FetchedEmail } from "./email.js";

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

// Route a Tier-3 escalation into arnie's --serve queue (<dir>/inbox/<id>.task).
async function routeToArnie(config: Config, ticket: Ticket, brief: string): Promise<string | null> {
  if (!config.arnieQueue) return null;
  const inbox = path.join(config.arnieQueue, "inbox");
  await fsp.mkdir(inbox, { recursive: true }).catch(() => {});
  const file = path.join(inbox, `${ticket.id}.task`);
  const task = `[escalated by Casey — ticket ${ticket.id}, client ${ticket.from}]\n\n${brief}`;
  await fsp.writeFile(file, task, "utf8");
  return file;
}

const TIER_COLOR: Record<number, (s: string) => string> = { 1: chalk.green, 2: chalk.yellow, 3: chalk.red };
const ACTION_LABEL: Record<string, string> = {
  resolve: "RESOLVE (Tier-1)",
  ask_client: "ASK CLIENT (Tier-1)",
  escalate: "ESCALATE → arnie (Tier-3)",
};

function indent(s: string): string {
  return s.split("\n").map((l) => "  " + l).join("\n");
}

function printTriage(t: TriageResult): void {
  const tc = TIER_COLOR[t.tier] ?? chalk.white;
  console.log(chalk.bold("\nTriage"));
  console.log(`  category : ${t.category}`);
  console.log(`  priority : ${t.priority}`);
  console.log(`  tier     : ${tc(`T${t.tier}`)}`);
  console.log(`  action   : ${chalk.bold(ACTION_LABEL[t.action] ?? t.action)}`);
  console.log(`  summary  : ${t.summary}`);
  if (t.missing_info.length) console.log(`  need     : ${t.missing_info.join("; ")}`);
  console.log(chalk.bold("\nClient reply"));
  console.log(chalk.dim("  ┄┄┄"));
  console.log(chalk.cyan(indent(t.client_reply)));
  console.log(chalk.dim("  ┄┄┄"));
  if (t.action === "escalate" && t.escalation_brief) {
    console.log(chalk.bold("\nEscalation brief → arnie (Tier-3)"));
    console.log(indent(t.escalation_brief));
  }
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
  const ticket = newTicket(incoming);
  console.log(chalk.dim(`ticket ${ticket.id} — from ${ticket.from} — "${ticket.subject}"`));

  const client = makeClient(config);
  const result = await triage(client, config.model, incoming);
  ticket.triage = result;
  printTriage(result);

  if (result.action === "escalate") {
    const routed = await routeToArnie(config, ticket, result.escalation_brief ?? result.summary);
    ticket.status = "escalated";
    ticket.routed_to = routed ?? undefined;
    if (routed) console.log(chalk.cyan(`\n→ routed to arnie: ${routed}`));
    else console.log(chalk.yellow("\n(no --arnie-queue set — escalation logged but not routed; pass --arnie-queue <dir>)"));
  } else if (result.action === "ask_client") {
    ticket.status = "awaiting_client";
  } else {
    ticket.status = "resolved";
  }

  await appendTicket(config.ticketStore, ticket);
  console.log(chalk.dim(`\nlogged → ${config.ticketStore}  (status: ${ticket.status})`));
}

async function cmdServe(config: Config): Promise<void> {
  const cfgPath = config.emailConfig ?? path.join(os.homedir(), ".casey", "email.json");
  let email: EmailConfig;
  try {
    email = await loadEmailConfig(cfgPath);
  } catch (e) {
    console.error(chalk.red(`serve: couldn't load email config from ${cfgPath}`));
    console.error(chalk.dim(`  ${e instanceof Error ? e.message : String(e)}`));
    console.error(chalk.dim("  run `casey email-config` for a template, then save it there (or pass --email-config <path>)."));
    process.exit(1);
  }
  const client = makeClient(config);
  console.log(chalk.dim(`serve: polling ${email.imap.user} (${email.mailbox}) every ${config.serveInterval}s — Ctrl+C to stop`));
  if (config.arnieQueue) console.log(chalk.dim(`  Tier-3 escalations → ${path.join(config.arnieQueue, "inbox")}`));

  let stop = false;
  process.on("SIGINT", () => {
    console.log(chalk.dim("\nserve: stopping after this cycle..."));
    stop = true;
  });

  while (!stop) {
    let emails: FetchedEmail[] = [];
    try {
      emails = await pollInbox(email);
    } catch (e) {
      console.error(chalk.red(`  inbox poll failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    const done: number[] = [];
    for (const em of emails) {
      if (stop) break;
      const ticket = newTicket(em);
      console.log(chalk.cyan(`\n[${ticket.id}] ${em.from} — "${em.subject}"`));
      try {
        const result = await triage(client, config.model, em);
        ticket.triage = result;
        console.log(`  ${result.category}/${result.priority}/T${result.tier} → ${ACTION_LABEL[result.action] ?? result.action}`);
        await sendReply(email, { to: em.from, subject: em.subject, body: result.client_reply, inReplyTo: em.messageId });
        console.log(chalk.dim(`  replied to ${em.from}`));
        if (result.action === "escalate") {
          const routed = await routeToArnie(config, ticket, result.escalation_brief ?? result.summary);
          ticket.status = "escalated";
          ticket.routed_to = routed ?? undefined;
          console.log(routed ? chalk.cyan(`  → arnie: ${path.basename(routed)}`) : chalk.yellow("  (no --arnie-queue — escalation not routed)"));
        } else {
          ticket.status = result.action === "ask_client" ? "awaiting_client" : "resolved";
        }
        done.push(em.uid);
      } catch (e) {
        console.error(chalk.red(`  failed: ${e instanceof Error ? e.message : String(e)} — leaving unread to retry`));
        ticket.status = "new";
      }
      await appendTicket(config.ticketStore, ticket);
    }
    if (done.length) {
      try {
        await markSeen(email, done);
      } catch (e) {
        console.error(chalk.red(`  markSeen failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
    if (stop) break;
    await new Promise((r) => setTimeout(r, config.serveInterval * 1000));
  }
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
