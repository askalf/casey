# Changelog

All notable changes to this project will be documented in this file.

<!--
Release convention: land changes under `## [Unreleased]`. At release time,
rename that heading to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh
`## [Unreleased]` above it.
-->

## [Unreleased]

## [0.1.0] - 2026-06-03

Initial release — an AI IT service-desk CSR (Tier-1 intake + triage).

- `casey triage <file|->` triages one ticket (JSON or a plain email) into a structured decision: category, priority, tier, and an action — `resolve` / `ask_client` / `escalate` — each with a ready-to-send client reply.
- `casey serve` runs the email daemon: polls an IMAP inbox, triages each new message, replies via SMTP, and routes Tier-3 escalations into arnie's `--serve` queue as task files — a hands-off Tier-1 → Tier-3 pipeline. Unhandled mail is left unread to retry.
- Routes the LLM through dario (or any Anthropic-compatible endpoint) via `--dario`; structured output uses JSON-mode so it passes cleanly through dario's wire shape.
- `casey email-config` prints a fillable IMAP/SMTP config template; every ticket is logged to `~/.casey/tickets.jsonl`.
