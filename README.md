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

| Channel | Status | Notes |
|---|---|---|
| **Email** (IMAP/SMTP) | ✅ | Any provider — Gmail app-password, Microsoft 365, generic IMAP. |
| **Web chat widget** | ✅ | Embeddable live-chat page served at `/`; clients chat with casey in real time. |
| **Universal webhook** | ✅ | `POST /webhook` — any system that speaks HTTP (forms, Zapier, SMS gateways, custom apps) plugs in with no bespoke integration. |
| Slack / Teams / Discord | 🚧 | Chat platforms — adapters on the roadmap. |
| SMS / Voice | 🚧 | Twilio adapters on the roadmap. |

New channels are just an adapter that implements the `Channel` interface (`receive` → `reply`); the triage → troubleshoot → escalate pipeline doesn't change.

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

# the Tier-3 fixer, alongside
arnie --serve ./queue --autonomous
```

`serve` runs every enabled channel at once: it polls the inbox, serves the web widget + webhook, triages and troubleshoots each request, replies through the originating channel, and drops Tier-3 escalations into `./queue/inbox` as arnie task files. Point arnie's `--serve` at the same directory and the tiers run hands-off.

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
--port <n>           HTTP port for --web / webhook (default: 8787)
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
