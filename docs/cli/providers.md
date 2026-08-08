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

## The provider chain

`~/.namzu/preferences.json` stores an **ordered list** of providers rather than a single one:

```json
{
  "version": 3,
  "providers": [
    { "id": "anthropic", "model": "claude-opus-4-7" },
    { "id": "ollama" }
  ]
}
```

The order is yours to declare, and the file is meant to be read and edited directly — you do not need to launch the TUI to see it. Index 0 is the **primary**. A member that omits `model` uses that provider's registry default, resolved at launch, so it tracks the default instead of pinning whatever it was on the day you wrote it.

**Today only the primary runs.** The rest of the chain is validated and reported; nothing falls over to it yet. Automatic failover is a separate change.

The chain is checked as a whole when it is read:

- Every member must name a provider namzu knows — including members after the first. An unusable fallback that only surfaces the day your primary goes down is what this prevents.
- A member cannot repeat an earlier one exactly. The same provider **with a different model** is allowed and is a legitimate chain: a large model falling back to a smaller one.
- The chain cannot be empty.

If any of those fail, namzu names the offending position (`primary provider`, `fallback #1`, …) and re-opens the picker.

### Seeing the chain

`namzu doctor` prints it in order, one line per member, each carrying that member's position, label, the model it will use — marked `(default)` when it came from the registry rather than from your file — and whether a credential was found:

```
providers.chain  2 providers configured, in order:
                 1. primary · <label> · <model> · credential found
                 2. fallback 1 · <label> · <model> (default) · NO CREDENTIAL
```

A fallback with no credential is a **warning**, not a failure — your primary still runs, so you are not blocked. A primary with no credential is a failure, because no run can start.

A purely local provider reports `reachable` / `NOT REACHABLE` instead, since it has no key to find.

### When the members disagree about what they can do

Providers do not all declare the same abilities. A local provider may declare it cannot call tools; a gateway may declare it cannot read image or document attachments. namzu negotiates capabilities **once per run**, against the provider it was given, and that answer decides whether tools go into the prompt and whether attachments are sent.

So a chain whose members disagree cannot simply be run. Taking the strongest declaration would advertise abilities a fallback does not have. Taking the weakest would cost your **primary** a capability on every run, to guard against a failure that happens rarely — you would have added a fallback for resilience and quietly lost tool support for it.

namzu chooses neither for you. It **refuses the chain and names the disagreement**:

```
The providers in your chain declare different capabilities, so namzu cannot honour the chain as written:
  - fallback #1 (<label>) declares it cannot call tools, while primary provider (<label>) declares it can call tools — if the chain falls over to it, tools become unavailable.
```

Every disagreeing capability is listed, not just the first, so you can fix the configuration in one pass.

Two ways forward: drop the member that disagrees, or accept the limitation:

```json
{
  "version": 3,
  "providers": [{ "id": "anthropic" }, { "id": "ollama" }],
  "allowCapabilityMismatch": true
}
```

With that set, the chain runs and the disagreement is **printed on every launch** — in the TUI, in `namzu run`, and as a `notice` event in `namzu run-stream`. Not once. An acceptance given months ago and forgotten is exactly how a chain quietly does less than you think.

Two things this check does **not** claim:

- It compares what each driver **declares**, at the type level. That is the only thing knowable without constructing a provider — and constructing one needs a credential, which the fallback you have not set up yet does not have. A constructed provider's own declaration is what the runtime ultimately honours.
- It says nothing about the current run. Only the primary runs today, so its capabilities are in force in full. Each sentence says what happens *if the chain falls over*, because that is what is true.

A member whose declaration cannot be read at all — a provider with no construction path yet — is reported as such rather than assumed to agree, and does not by itself refuse the chain.

### Upgrading from the previous format

A `version: 2` file (one `provider`, one optional `model`) is read as a one-member chain, so nothing needs doing. The file is rewritten in the new format the next time a choice is saved. A `version: 1` file is still refused and asks you to pick again.

### Overriding on the command line

`namzu run --provider <id>` **replaces** the chain for that run: the run uses exactly the provider you named and nothing else. An override that quietly kept your fallbacks could answer from a provider you did not name on that command line.

`--model <name>` on its own re-models the primary and leaves the rest of the chain in place.
