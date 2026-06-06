# Changelog

All notable changes to this project will be documented in this file.

<!--
Release convention: land changes under `## [Unreleased]`. At release time,
rename that heading to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh
`## [Unreleased]` above it.
-->

## [Unreleased]

- **Operator console** — a single-pane web UI at `/console` (served by `casey serve --web`, loopback). Two views toggled in one pane:
  - **User** — the live client chat, running through Casey's real triage → troubleshoot → escalate pipeline.
  - **Admin / Dev** — a sidebar-and-detail cockpit: every ticket with its full thread, triage, and Arnie's Tier-3 outcome + report rendered inline; stack-health panel (casey / arnie / dario, with Arnie liveness derived from the escalation backlog) and ticket counts.
  - **Full control** — close / reopen a ticket, re-dispatch a stuck escalation to Arnie, and reply into a thread as Casey (delivered for push channels; record-only for synchronous web/webhook). Backed by a small JSON API (`/api/tickets`, `/api/ticket`, `/api/health`, `/api/ticket/{close,reopen,redispatch,reply}`) reading the existing `tickets.jsonl` + Arnie queue artifacts — no new datastore.
  - Adds a `closed` ticket status.
  - **KPI strip** (open / P1 open / today / in-flight escalations / open-by-tier / resolved-closed), a **live activity feed** as the default detail view (intake → triage → escalate → Arnie-done, reconstructed from the append-only ticket log + Arnie outcomes via `/api/activity`), and **instant search** over the ticket list.
  - Auto-refresh is change-detected and scroll-preserving — it re-renders only when data actually changed and keeps your scroll position, so reading a long thread/report is no longer interrupted.
  - **Role-scoped views** — a role switcher re-skins the single pane per team (no auth yet; the seed of the MSP-platform direction). Live roles scope the list + gate actions + carry a context blurb: **Owner** (oversight), **Service Desk/CSR** (intake+triage, open queue), **Dispatch** (all open, priority-sorted), **T3/Approver** (Arnie escalations), **Security** (security-classed). Planned roles (Backup, Bench, Procurement, Project, Sales, Account Manager, Accounting/HR, Dev) show a labeled placeholder with the phase they arrive in. Selection persists in localStorage.
  - **Approval gate — review/sign-off surface** (first half of the human-in-the-loop gate). T3/Security/Owner can **Approve/Reject** an Arnie escalation from the console; the decision is recorded on the ticket (`approval` field) and a `<id>.decision.json` is written into Arnie's queue — the contract Arnie will read to execute-on-approval or stand down (the execute side ships as its own change). New `/api/ticket/{approve,reject}` endpoints; a "needs approval" KPI + an ⏳ list chip surface the queue.
  - **Client + asset model** — tickets become *this client, this machine*. A native client/asset registry (`clients.jsonl`, dedupe-by-id) with `/api/clients` (list/create), `/api/client/asset` (add), and `/api/ticket/client` (attach). CSR/Dispatch/Owner get a Client/Asset picker in the detail (create clients/assets inline); the client shows as a list chip. Tickets carry `clientId`/`assetId`. Native source of truth for now (RMM/PSA sync can layer on later).
  - **SLA timers + assignment + Dispatch board** — priority→SLA targets (P1 4h … P4 48h resolution; response targets too) computed per ticket (`ok`/`at_risk`/`breached`/`met`/`missed`) and surfaced as a colored chip, a detail line, and an "SLA breached" KPI. Tickets carry an `assignee` (free-text until identity lands) set via `/api/ticket/assign`; shown as `@owner`. The **Dispatch** role now sorts by SLA urgency (breached → at-risk → soonest-due) and can assign owners.

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
