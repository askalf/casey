import os from "node:os";
import path from "node:path";

export interface Config {
  model: string;
  baseUrl?: string;
  dario: boolean;
  ticketStore: string; // JSONL log of every ticket + its triage
  arnieQueue?: string; // dir for Tier-3 hand-offs; tasks land in <dir>/inbox (arnie --serve <dir>)
  emailConfig?: string; // path to email.json (default ~/.casey/email.json)
  serveInterval: number; // seconds between inbox polls in `serve`
  web: boolean; // enable the web chat widget + universal webhook (HTTP push channel)
  port: number; // HTTP port for push channels (web/webhook/slack/teams)
  slack: boolean; // Slack Events API (env: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET)
  discord: boolean; // Discord gateway (env: DISCORD_BOT_TOKEN)
  teams: boolean; // MS Teams Bot Framework (env: TEAMS_APP_ID, TEAMS_APP_PASSWORD)
  sms: boolean; // Twilio SMS (env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER)
  voice: boolean; // Twilio Voice (env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  showHelp: boolean;
  showVersion: boolean;
}

const DEFAULTS: Config = {
  model: "claude-opus-4-7",
  dario: false,
  ticketStore: path.join(os.homedir(), ".casey", "tickets.jsonl"),
  serveInterval: 30,
  web: false,
  port: 8787,
  slack: false,
  discord: false,
  teams: false,
  sms: false,
  voice: false,
  showHelp: false,
  showVersion: false,
};

export function parseArgs(argv: string[]): { config: Config; command: string; args: string[] } {
  const config: Config = { ...DEFAULTS };
  let command = "";
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (label: string): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${label} requires a value`);
      return v;
    };
    switch (a) {
      case "-h":
      case "--help":
        config.showHelp = true;
        break;
      case "--version":
        config.showVersion = true;
        break;
      case "--model":
        config.model = next("--model");
        break;
      case "--base-url":
        config.baseUrl = next("--base-url");
        break;
      case "--dario":
        config.dario = true;
        break;
      case "--ticket-store":
        config.ticketStore = next("--ticket-store");
        break;
      case "--arnie-queue":
        config.arnieQueue = next("--arnie-queue");
        break;
      case "--email-config":
        config.emailConfig = next("--email-config");
        break;
      case "--interval": {
        const v = parseInt(next("--interval"), 10);
        if (!Number.isFinite(v) || v <= 0) throw new Error("--interval must be a positive integer (seconds)");
        config.serveInterval = v;
        break;
      }
      case "--web":
        config.web = true;
        break;
      case "--slack":
        config.slack = true;
        break;
      case "--discord":
        config.discord = true;
        break;
      case "--teams":
        config.teams = true;
        break;
      case "--sms":
        config.sms = true;
        break;
      case "--voice":
        config.voice = true;
        break;
      case "--port": {
        const v = parseInt(next("--port"), 10);
        if (!Number.isFinite(v) || v <= 0 || v > 65535) throw new Error("--port must be a port number (1-65535)");
        config.port = v;
        break;
      }
      default:
        if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
        if (!command) command = a;
        else args.push(a);
    }
  }
  return { config, command, args };
}

export const HELP = `casey — AI IT service-desk CSR (Tier-1 intake + triage)

Usage: casey <command> [options]

Commands:
  triage <file>        Triage one ticket from a file — JSON {from,subject,body},
                       or a plain email ("From: ...\\nSubject: ...\\n\\n<body>").
                       Prints the triage + the client reply; routes Tier-3 to arnie.
  triage -            Read the ticket from stdin.
  serve                Run the omnichannel service desk: take tickets in across every
                       enabled channel, triage (Tier-1), troubleshoot (Tier-2), and
                       escalate to arnie (Tier-3). Enable channels with the flags below
                       — at least one of email (~/.casey/email.json) or --web.
  email-config         Print a sample email.json (IMAP + SMTP) to fill in.

Channels (serve):
  email                Auto-on when ~/.casey/email.json exists (or --email-config <f>).
  --web                Web chat widget (GET /) + universal webhook (POST /webhook).
  --slack              Slack Events API (env: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET).
  --discord            Discord gateway bot (env: DISCORD_BOT_TOKEN).
  --teams              MS Teams Bot Framework (env: TEAMS_APP_ID, TEAMS_APP_PASSWORD).
  --sms                Twilio SMS (env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER).
  --voice              Twilio Voice — spoken support line (env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN).
  --port <n>           HTTP port for web/webhook/slack/teams/sms/voice endpoints (default: 8787)

Options:
  --dario              Route the LLM through a local dario proxy (localhost:3456)
  --base-url <url>     Anthropic-compatible endpoint
  --model <id>         Model (default: claude-opus-4-7)
  --arnie-queue <dir>  Drop Tier-3 hand-offs into <dir>/inbox as arnie *.task files
                       (run the fixer with: arnie --serve <dir>/inbox --autonomous)
  --email-config <f>   Path to the IMAP/SMTP config (default: ~/.casey/email.json)
  --interval <sec>     Seconds between inbox polls in serve (default: 30)
  --ticket-store <f>   Ticket log JSONL (default: ~/.casey/tickets.jsonl)
  --version            Print version
  -h, --help           Show this help

Environment:
  ANTHROPIC_API_KEY    Required (or use --dario to route through a local dario proxy).
`;
