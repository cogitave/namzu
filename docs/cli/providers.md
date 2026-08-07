---
title: Providers & credentials
description: How namzu discovers LLM credentials, the first-run provider picker, and switching providers.
last_updated: 2026-08-07
status: current
related_packages: ["@namzu/cli", "@namzu/anthropic", "@namzu/openai", "@namzu/openrouter", "@namzu/ollama"]
---

# Providers & credentials

namzu is **credential-first**: it never runs a login flow. On launch it discovers credentials already present on your machine and lets you choose which LLM provider to chat through.

## If nothing is found, you can type one

When no credential is discovered, the picker offers `k` — paste a key and use it
straight away, without leaving namzu.

**It is kept in memory for that session only and is never written anywhere.**
The screen says so before you type and again after. To make it durable, set the
environment variable the same screen names, and restart.

That is a deliberate limit rather than an unfinished one. The obvious durable
home would be the OS keychain, and namzu's keychain support is macOS-only and
reads a *different* product's credential store — writing your key there would
file it under someone else's name, and on Windows there is no keychain path at
all. The remaining option was a plaintext file, and a secret at rest should be
something you chose rather than something that arrived because you typed into a
text field.

While you type, only a mask is shown — never the key, and never its length. The
key is checked with the provider at the moment you enter it, by listing models,
which costs nothing. If the provider rejects it you stay on the screen with what
you typed intact, so a one-character slip is fixable. If the provider has no way
to check a key cheaply, namzu says exactly that rather than implying it verified
something.

A typed credential is listed as `typed · this session only` wherever providers
are shown, so you can always see which one disappears when you close the
terminal.

## Where credentials are discovered

namzu scans these sources, in order, and offers whatever it finds:

1. **Environment variables** — e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`.
2. **macOS Keychain** — the Claude Code OAuth credential (`Claude Code-credentials`). This lets namzu reuse an existing Claude Code sign-in with no API key. macOS only.
3. **Local probes** — a reachable Ollama server (e.g. `localhost:11434`).

> **Removed in 0.7.0:** namzu also used to read the `secrets.toml` of an external peer daemon it integrated with, ahead of the Keychain. That integration is gone. A credential kept only in that file is no longer found — export it as one of the environment variables above instead. `namzu doctor` lists the sources actually scanned.

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
