# Deploying casey

casey is a single Node service. Point it at a model endpoint (an Anthropic API key,
or a [dario](https://github.com/askalf/dario) proxy on a Claude subscription), enable
the channels you want, and expose its HTTP port for the web / webhook / Slack / Teams
endpoints. The Discord gateway needs no inbound URL.

## Build & run (standalone)

```
docker build -t casey .
docker run -d --name casey -p 8787:8787 \
  -e ANTHROPIC_API_KEY=sk-ant-… \
  -v casey-data:/root/.casey \
  casey serve --web --port 8787
```

Open `http://localhost:8787/` for the chat widget. Add channels by overriding the
command, e.g. `casey serve --web --slack --discord --teams --arnie-queue /agent-output/casey-queue`.

## On a Claude subscription (via dario)

Route the model through a dario container on the same Docker network — no per-token
billing. See `docker-compose.casey.yml`; the key bit is the env:

```
ANTHROPIC_API_KEY=dario
ANTHROPIC_BASE_URL=http://dario:3456
```

casey reads these from the environment, so no `--dario` flag is needed off-box.

## Public URL

The web widget, universal webhook, Slack Events API, and Teams messaging endpoint all
need a public HTTPS URL — put casey behind a reverse proxy or a Cloudflare tunnel:

| Path | Channel |
|---|---|
| `/`               | web chat widget |
| `/webhook`        | universal webhook |
| `/slack/events`   | Slack Events API Request URL |
| `/teams/messages` | Teams messaging endpoint |

A Cloudflare tunnel ingress routes a hostname (e.g. `support.example.com`) to
`http://casey:8787`; add the DNS record and it's live.

## Go-live order

1. **Web widget** — no third-party creds; embed it on a site or share the URL.
2. **Email** — drop `~/.casey/email.json` (template: `casey email-config`) on the `casey-data` volume.
3. **Chat** — set the platform creds below and add `--slack` / `--discord` / `--teams`.

## Channel credentials (env)

| Channel | env vars |
|---|---|
| Slack   | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` |
| Discord | `DISCORD_BOT_TOKEN` |
| Teams   | `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD` |

See the main README for each platform's setup steps.
