# casey

**An AI IT service-desk CSR — Tier-1 intake + triage.** casey reads inbound client tickets (email), triages each by category / priority / tier, resolves the Tier-1 things itself, and routes the genuinely technical ones to a Tier-3 engineer. It pairs with [arnie](https://github.com/askalf/arnie) (the autonomous Tier-3 fixer) to form a working two-tier IT support team, and routes its LLM calls through [dario](https://github.com/askalf/dario) so it runs on a Claude subscription.

```
client email ──▶ casey (Tier-1) ──┬─▶ resolve   → reply with the fix
                                   ├─▶ ask       → reply asking for the missing details
                                   └─▶ escalate  → reply + hand a brief to arnie (Tier-3)
```

## What it does

Every inbound ticket is triaged into a structured decision:

- **category** — account_access, email, hardware, software, network, printing, security, data, performance, how_to, other
- **priority** — P1 (business-down / security) … P4 (minor / how-to)
- **action** — exactly one of:
  - `resolve` — casey writes the client a complete, friendly fix (how-tos, known fixes, self-serve steps)
  - `ask_client` — casey asks for exactly the missing details, warmly and specifically
  - `escalate` — casey sends an honest holding reply **and** drops a crisp technical brief into arnie's queue for hands-on diagnosis

casey is honest by design: it won't promise a Tier-1 fix it can't deliver, and it won't escalate something the client could do themselves in a couple of steps.

## Install

```
npm install -g casey-cli
```

## Use

### Triage a single ticket (great for testing)

```
casey triage ticket.txt --dario
```

`ticket.txt` is JSON `{"from","subject","body"}` or a plain email:

```
From: jane@acme.com
Subject: printer jammed

The 3rd-floor printer won't print.
```

You can also pipe a ticket in: `cat ticket.txt | casey triage - --dario`.

### Run the email service desk (daemon)

```
casey email-config > ~/.casey/email.json     # then fill in your support inbox
casey serve --dario --arnie-queue ./queue     # poll → triage → reply → route
arnie --serve ./queue --autonomous            # the Tier-3 fixer, alongside
```

casey polls the inbox, triages each new email, replies to the client, and drops Tier-3 escalations into `./queue/inbox` as arnie task files. Point arnie's `--serve` at the same directory and the two tiers run hands-off.

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

Works with any IMAP/SMTP provider (Gmail app-password, Microsoft 365, generic IMAP). Credentials stay in this local file — they're never sent anywhere but your mail server.

## Flags

```
--dario              Route the LLM through a local dario proxy (localhost:3456)
--base-url <url>     Anthropic-compatible endpoint
--model <id>         Model (default: claude-opus-4-7)
--arnie-queue <dir>  Drop Tier-3 hand-offs into <dir>/inbox as arnie task files
--email-config <f>   Path to the IMAP/SMTP config (default: ~/.casey/email.json)
--interval <sec>     Seconds between inbox polls in serve (default: 30)
--ticket-store <f>   Ticket log JSONL (default: ~/.casey/tickets.jsonl)
```

## How it works

casey asks the model for a structured JSON triage — it uses JSON-mode rather than forced tool calls, so it routes cleanly through dario's Claude-Code wire shape. Every ticket and its triage is appended to a JSONL log; Tier-3 escalations are written as plain-text task files into arnie's `--serve` queue. A failed poll/triage leaves the email unread so it's retried on the next cycle.

## Development

```
npm run dev        # tsx watch
npm run typecheck
npm run build      # tsc → dist/
npm test           # offline tests (parsing + schema)
```

## License

MIT.

---

Part of [askalf](https://github.com/askalf) — the open-source AI workforce. **casey** (Tier-1) + **arnie** (Tier-3) + **dario** (the model router).
