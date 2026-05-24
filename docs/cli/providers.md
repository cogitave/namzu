---
title: Providers & credentials
description: How namzu discovers LLM credentials, the first-run provider picker, and switching providers.
last_updated: 2026-05-25
status: current
related_packages: ["@namzu/cli", "@namzu/anthropic", "@namzu/openai", "@namzu/openrouter", "@namzu/ollama"]
---

# Providers & credentials

namzu is **credential-first**: it never runs a login flow. On launch it discovers credentials already present on your machine and lets you choose which LLM provider to chat through.

## Where credentials are discovered

namzu scans these sources, in order, and offers whatever it finds:

1. **Environment variables** — e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`.
2. **clawtool secrets** — the `secrets.toml` managed by clawtool, if present.
3. **macOS Keychain** — the Claude Code OAuth credential (`Claude Code-credentials`). This lets namzu reuse an existing Claude Code sign-in with no API key. macOS only.
4. **Local probes** — a reachable Ollama server (e.g. `localhost:11434`).

If nothing is found, namzu shows the picker in an empty state explaining exactly which environment variable to set (or to start Ollama), then restart.

## The picker

On first run, or after `/model`, the picker lists each detected provider with its source label (for example `keychain · Claude Code-credentials`, `env · ANTHROPIC_API_KEY`, `local · localhost:11434`). Use `↑`/`↓` to navigate, `Enter` to accept, `Esc` to cancel. Your choice is saved to `~/.namzu/preferences.json` and reused on the next launch.

## Anthropic: API key vs OAuth

namzu detects which kind of Anthropic credential it has and authenticates accordingly:

- **Console API key** (`sk-ant-api…`) → standard `x-api-key` auth.
- **Claude Code OAuth token** (from the Keychain) → Bearer auth with the full Claude Code identity (the required beta headers, a `claude-cli` user-agent, and the Claude Code system-prompt prefix). This is what makes a Keychain sign-in work without an API key.

## Supported providers

The picker currently wires Anthropic, OpenAI, OpenRouter, and Ollama. Other providers in the registry surface as they gain credential detection.

## Switching providers

Run `/model` inside the TUI to re-open the picker at any time. The new choice is saved and the session reconnects.
