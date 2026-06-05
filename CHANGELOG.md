# Changelog

All notable changes to this project will be documented in this file.

<!--
Release convention: land changes under `## [Unreleased]`. At release time,
rename that heading to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh
`## [Unreleased]` above it.
-->

## [Unreleased]

## [0.1.1] - 2026-06-05

First npm release — an omnichannel AI IT service desk (Tier-1 triage + Tier-2 guided troubleshooting), pairing with arnie (Tier-3).

- **Packaging** — npm metadata (`repository`/`homepage`/`bugs`); docs corrected so arnie's `--serve` points at `<queue>/inbox` (casey writes briefs there; arnie reads `*.task` flat).

- **Channel-agnostic core.** Every channel is an adapter feeding one pipeline; tickets are handled the same regardless of origin and replies route back out the same channel.
  - **Email** (IMAP poll + SMTP reply) — auto-on when `~/.casey/email.json` exists.
  - **Web chat widget** — a self-contained live-chat page served at `/` (enable with `--web`).
  - **Universal webhook** — `POST /webhook`; any system that speaks HTTP plugs in with no bespoke integration.
  - **Slack** (`--slack`, Events API), **Discord** (`--discord`, gateway), **Microsoft Teams** (`--teams`, Bot Framework) — chat-platform adapters; credentials via env. Adapter-complete + offline-tested; live-validated on provisioning each platform's credentials.
  - **SMS** (`--sms`) and **Voice** (`--voice`) via Twilio — signed webhooks; SMS replies via the Messaging API, Voice runs a spoken TwiML conversation. Adapter-complete + offline-tested; needs a Twilio account + number.
- **Tier-1 triage** — classifies each request (category / priority / tier) and either resolves it with a complete reply or asks for the one missing detail.
- **Tier-2 guided troubleshooting** — a multi-turn diagnostic conversation for problems a client can fix with guidance; tracks the thread by conversation id so a reply continues the same ticket; resolves or escalates with a richer brief.
- **Tier-3 escalation** — drops a crisp technical brief into arnie's `--serve` queue for hands-on problems and site-wide outages.
- `casey serve` runs every enabled channel at once (poll loop for email + HTTP server for web/webhook). `casey triage <file|->` triages/handles a single ticket for testing. `casey email-config` prints a fillable IMAP/SMTP template.
- Routes the LLM through dario (or any Anthropic-compatible endpoint) via `--dario`; structured output uses JSON-mode so it passes cleanly through dario's wire shape. Every ticket + its conversation is logged to `~/.casey/tickets.jsonl`.
