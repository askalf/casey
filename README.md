# casey

**An AI IT service desk — omnichannel intake, Tier-1 triage, and Tier-2 guided troubleshooting.** casey takes client support requests in across *any* channel, triages each one, resolves the simple things itself, walks the client through the ones that need guided troubleshooting, and hands the genuinely hands-on problems to a Tier-3 engineer — with a real brief. It pairs with [arnie](https://github.com/askalf/arnie) (the autonomous Tier-3 fixer) to form a working IT support team, and routes its LLM calls through [dario](https://github.com/askalf/dario) so it runs on a Claude subscription.

```
            ┌─ email ───┐
            ├─ web chat ─┤                  ┌─ Tier-1  resolve / ask         → reply
 a client ──┼─ webhook ──┼──▶  casey  ──────┼─ Tier-2  guided troubleshooting → reply (multi-turn)
            ├─ slack* ───┤   (one pipeline) └─ Tier-3  escalate → arnie + brief
            └─ sms* / voice* ┘
                                            * roadmap — the core is channel-agnostic
```

Every channel feeds one pipeline, so a ticket is handled the same way no matter where it came from, and the reply goes back out the same way it came in.

## The tiers

- **Tier-1 — triage.** Each request is classified (category / priority / tier) and either **resolved** on the spot (a complete how-to or known fix), or casey **asks** for the one missing detail it needs.
- **Tier-2 — guided troubleshooting.** Problems a client can fix *with guidance* (Outlook won't stay connected, an app won't install, Wi-Fi is flaky on one laptop) get a real back-and-forth: casey asks focused diagnostic questions, gives one clear step at a time, interprets the answers, and converges on a fix. It tracks the conversation, so a client's reply continues the same ticket.
- **Tier-3 — escalate.** When something genuinely needs hands-on access — server-side config, network gear, AD/DNS, a site-wide outage — casey sends an honest holding reply and drops a crisp technical brief into [arnie](https://github.com/askalf/arnie)'s queue.

The deciding question between Tier-2 and Tier-3 is *who can act*: if a single user can do it by following steps, it's Tier-2; if it needs admin/server access or affects many users at once, it's Tier-3. Tier-2 can always escalate later if guided steps don't resolve it.

## Channels

| Channel | Status | Enable with |
|---|---|---|
| **Email** (IMAP/SMTP) | ✅ live | auto-on with `~/.casey/email.json` — Gmail app-password, Microsoft 365, generic IMAP |
| **Web chat widget** | ✅ live | `--web` — embeddable live-chat page at `/` |
| **Universal webhook** | ✅ live | `--web` — `POST /webhook`, any HTTP source (forms, Zapier, gateways, apps) |
| **Slack** | ✅ built | `--slack` + `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` |
| **Discord** | ✅ built | `--discord` + `DISCORD_BOT_TOKEN` |
| **Microsoft Teams** | ✅ built | `--teams` + `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD` |
| **SMS** (Twilio) | ✅ built | `--sms` + `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_NUMBER` |
| **Voice** (Twilio) | ✅ built | `--voice` + `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` |

*✅ built* = adapter complete and offline-tested; live-validated once you provision that platform's credentials. New channels are just an adapter that implements the `Channel` interface (`receive`/`listen` → `reply`); the triage → troubleshoot → escalate pipeline doesn't change.

## Install

```
npm install -g casey-cli
```

## Use

### Triage a single ticket (great for testing)

```
casey triage ticket.txt --dario
```

`ticket.txt` is JSON `{"from","subject","body"}` or a plain email (`From:` / `Subject:` headers, blank line, body). You can also pipe it in: `cat ticket.txt | casey triage - --dario`. casey prints the triage and the outcome (resolved / troubleshooting / escalated) and the reply it would send.

### Run the service desk (daemon)

```
# web chat widget + universal webhook
casey serve --web --dario --arnie-queue ./queue
#   → chat widget at http://127.0.0.1:8787/   ·   POST http://127.0.0.1:8787/webhook

# email, too (auto-on when ~/.casey/email.json exists)
casey email-config > ~/.casey/email.json     # then fill in your support inbox
casey serve --web --dario --arnie-queue ./queue

# the Tier-3 fixer, alongside — casey writes briefs to ./queue/inbox, so point arnie there
arnie --serve ./queue/inbox --autonomous
```

`serve` runs every enabled channel at once: it polls the inbox, serves the web widget + webhook, triages and troubleshoots each request, replies through the originating channel, and drops Tier-3 escalations into `./queue/inbox` as arnie task files. Point arnie's `--serve` at that `./queue/inbox` directory (arnie reads `*.task` flat, so give it the `inbox` path, not the queue root) and the tiers run hands-off.

### The web widget

`--web` serves a self-contained chat widget at `/` (no build step, no dependencies). It keeps a session id in the browser so a conversation threads correctly, and it's the same `POST /web` endpoint underneath — drop it behind a reverse proxy or tunnel and it's a live support channel on your site.

### The universal webhook

```
curl -sX POST http://127.0.0.1:8787/webhook \
  -H 'content-type: application/json' \
  -d '{"channel":"portal","conversationId":"acme-42","from":"jane@acme.com","subject":"VPN","text":"VPN won'\''t connect"}'
# → {"conversationId":"acme-42","reply":"…","status":"ok"}
```

Anything that can POST JSON becomes a channel. Pass a stable `conversationId` to keep a thread together across messages.

### Chat channels (Slack / Discord / Teams)

Each chat platform is a `Channel` adapter enabled by a flag; credentials come from the environment. They need a publicly reachable host for their webhooks/gateway (see "go live").

```
SLACK_BOT_TOKEN=xoxb-…  SLACK_SIGNING_SECRET=…  casey serve --slack --dario
DISCORD_BOT_TOKEN=…                              casey serve --discord --dario
TEAMS_APP_ID=…  TEAMS_APP_PASSWORD=…             casey serve --teams --dario
```

- **Slack** — create a Slack app, add a bot token (`chat:write`, `app_mentions:read`, message-history scopes), subscribe to message events, and point the Events API Request URL at `https://<host>/slack/events`. The signing secret verifies each request.
- **Discord** — create an application + bot, enable the **Message Content** intent, and invite it with *Send Messages* + *Read Message History*. It connects over the gateway (no public URL needed for intake; replies go via the REST API).
- **Microsoft Teams** — register an Azure Bot, add the Teams channel, and set the messaging endpoint to `https://<host>/teams/messages`. Replies use an app-credentials token against the Bot Framework connector.

All flags compose — `casey serve --web --slack --discord --teams --dario` runs every channel against one pipeline at once.

### Phone channels (SMS / Voice via Twilio)

```
TWILIO_ACCOUNT_SID=AC…  TWILIO_AUTH_TOKEN=…  TWILIO_NUMBER=+1…  casey serve --sms --dario
TWILIO_ACCOUNT_SID=AC…  TWILIO_AUTH_TOKEN=…                      casey serve --voice --dario
```

- **SMS** — point your Twilio number's Messaging webhook at `https://<host>/sms`. casey verifies the Twilio signature, replies via the Messaging API, and threads by sender number.
- **Voice** — point the number's Voice webhook at `https://<host>/voice`. casey greets the caller, gathers speech, triages it, and speaks the reply (TwiML), looping until the caller's done. Replies are spoken inline, so watch model latency against Twilio's webhook timeout for long troubleshooting turns.

If signature verification trips behind a proxy, set `TWILIO_PUBLIC_BASE=https://<host>` so the signed URL is reconstructed exactly.

## Configuration

`~/.casey/email.json` (print a template with `casey email-config`):

```json
{
  "imap": { "host": "imap.gmail.com", "port": 993, "secure": true, "user": "support@yourco.com", "pass": "<app-password>" },
  "smtp": { "host": "smtp.gmail.com", "port": 465, "secure": true, "user": "support@yourco.com", "pass": "<app-password>" },
  "from": "IT Service Desk <support@yourco.com>",
  "mailbox": "INBOX"
}
```

Credentials stay in this local file — they're never sent anywhere but your mail server.

## Flags

```
--dario              Route the LLM through a local dario proxy (localhost:3456)
--base-url <url>     Anthropic-compatible endpoint
--model <id>         Model (default: claude-opus-4-7)
--web                Enable the web chat widget (GET /) + universal webhook (POST /webhook)
--slack              Slack Events API channel   (env: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET)
--discord            Discord gateway bot        (env: DISCORD_BOT_TOKEN)
--teams              MS Teams Bot Framework      (env: TEAMS_APP_ID, TEAMS_APP_PASSWORD)
--sms                Twilio SMS                  (env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER)
--voice              Twilio Voice (spoken line)  (env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
--port <n>           HTTP port for web/webhook/slack/teams/sms/voice (default: 8787)
--arnie-queue <dir>  Drop Tier-3 hand-offs into <dir>/inbox as arnie *.task files
--email-config <f>   Path to the IMAP/SMTP config (default: ~/.casey/email.json)
--interval <sec>     Seconds between inbox polls in serve (default: 30)
--ticket-store <f>   Ticket log JSONL (default: ~/.casey/tickets.jsonl)
--version            Print version
-h, --help           Show this help
```

## How it works

- **Channel-agnostic core.** Every channel is an adapter implementing a small `Channel` interface; one pipeline (`src/pipeline.ts`) takes an inbound message, advances its ticket through the tiers, and returns the reply. Push channels (web, webhook) register routes on a shared HTTP server; poll channels (email) run on a timer.
- **JSON-mode, not tool calls.** Triage and troubleshooting ask the model for a structured JSON result in text rather than a forced tool call, so they route cleanly through dario (which reshapes the request and doesn't preserve forced `tool_choice`).
- **Stateful conversations.** Every ticket and its full conversation is appended to a JSONL log; a client's reply is matched back to its open ticket by conversation id, so Tier-2 troubleshooting can span many turns.
- **Honest by design.** casey won't promise a fix it can't deliver, and it won't escalate something the client could do in a couple of guided steps.

## Development

```
npm run dev        # tsx watch
npm run typecheck
npm run build      # tsc → dist/
npm test           # offline tests (parsing, schemas, threading, channels)
```

## License

MIT.

---

Part of [askalf](https://github.com/askalf) — the open-source AI workforce. **casey** (Tier-1 + Tier-2) + **arnie** (Tier-3) + **dario** (the model router).
