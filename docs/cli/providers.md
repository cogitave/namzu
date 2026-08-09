---
title: Providers & credentials
description: How namzu discovers LLM credentials, the first-run provider picker, and switching providers.
last_updated: 2026-08-09
status: current
related_packages: ["@namzu/cli", "@namzu/anthropic", "@namzu/openai", "@namzu/openrouter", "@namzu/ollama"]
---

# Providers & credentials

namzu is **credential-first**: it never runs a login flow. On launch it discovers credentials already present on your machine and lets you choose which LLM provider to chat through.

## If nothing is found, you can type one

When no credential is discovered, the picker offers `k` — paste a credential and
use it straight away, without leaving namzu.

**Both kinds are accepted**: an API key, or a subscription token. namzu reads
which one you pasted from its own shape, sends it on the wire accordingly, and
says which kind it took. A pasted subscription token comes with no refresh data,
so it expires within hours and namzu cannot renew it — the screen tells you that
as you paste, rather than letting you find out as an authentication failure in
the middle of a turn. A subscription token discovered from the macOS Keychain
*is* renewed automatically, because that one arrives with its refresh data.

## A saved provider with no credential

Launching with a provider saved in `~/.namzu/preferences.json` and no credential
for it on the machine puts you **in the picker**, with the reason printed on it.
From there you can press `k` to enter a credential for that saved provider, or
choose a different one; `Esc` or `Ctrl+C` leaves.

This is offered even when other providers *are* detected — the list you land on
would otherwise name every provider except the one you actually chose.

Entering a credential for the saved provider keeps the rest of your saved chain,
including a pinned model. Choosing a different provider replaces it and is
written to your preferences as usual.

Before, this launched into a screen with a disabled composer whose only advice
was to pick another provider — on the one screen that could not pick one.

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

**The Keychain path is macOS-only.** On Windows and Linux there are exactly two doors: an environment variable, or a reachable local server. A credential kept only in your OS credential store is not found on those platforms.

**A local server that is not running is not listed.** Appearing in the list means namzu can use that provider *right now* — `namzu doctor` reads presence itself as "reachable" for a provider that needs no key, and the chain builder will build a member from it. An entry for a server that is down would make both of those wrong. The empty-state screen above is where you are told a local server is an option, and it names both ports.

## The picker

On first run, or after `/model`, the picker lists each detected provider with its source label (for example `keychain · Claude Code-credentials`, `env · ANTHROPIC_API_KEY`, `local · localhost:11434`). Use `↑`/`↓` to navigate, `Enter` to accept, `Esc` to cancel. Your choice is saved to `~/.namzu/preferences.json` and reused on the next launch.

## Anthropic: API key vs OAuth

namzu detects which kind of Anthropic credential it has and authenticates accordingly:

- **Console API key** (`sk-ant-api…`) → standard `x-api-key` auth.
- **Claude Code OAuth token** (from the Keychain) → Bearer auth with the full Claude Code identity (the required beta headers, a `claude-cli` user-agent, and the Claude Code system-prompt prefix). This is what makes a Keychain sign-in work without an API key.

## Supported providers

The picker currently wires Anthropic, OpenAI, OpenRouter, and Ollama. Other providers in the registry surface as they gain credential detection.

### A provider this build cannot run

namzu knows about more providers than it bundles drivers for. A driver package exists in the repository for each one, but only the four above are dependencies of the CLI, so only those four can be loaded and used.

The rest are still **discovered**, because discovery is honest — a local server really is running, a credential really is present — and they appear in the picker with `unavailable in this build` beside the source. They cannot be chosen:

```
2. fallback 1 · <label> · <model> · local · localhost:1234 · unavailable in this build
```

Choosing one is refused with the reason and the providers you can pick instead. The same refusal happens in three other places, so there is no route around it:

- a **saved primary** naming one is refused when `preferences.json` is read, and you land in the picker with the reason printed above it;
- **`writePreferences`** will not save one as the primary at all;
- **`namzu doctor`** reports it under `Could not read what these members declare`.

A **fallback** naming one is treated differently on purpose: it is dropped from the chain at launch with a notice, and your session runs. Refusing the whole file over a spare would take away a primary that works.

Excluding these rows from the picker entirely was considered and rejected — an operator whose only local server is one of them would then see `No providers detected`, which is false. namzu found it and declined it, and a refusal that presents as an absence is not a refusal.

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

The order is yours to declare, and the file is meant to be read and edited directly — you do not need to launch the TUI to see it. Index 0 is the **primary**.

**A member that omits `model` gets namzu's own default for that provider**, from a table compiled into the release. It is resolved at launch, but it is not *refreshed* at launch: nothing asks the provider what its current default is, so the value moves only when you upgrade namzu, and between releases it can name a model the provider has superseded. If you care which model a member runs, give it an explicit `model`. Omitting it is the right choice when you want whatever namzu currently considers sensible, and the wrong one if you read it as tracking the provider.

When the primary cannot serve a turn, namzu moves to the next member and carries on — see [When a member cannot serve](#when-a-member-cannot-serve).

The chain is checked as a whole when it is read:

- Every member must name a provider namzu knows — including members after the first. An unusable fallback that only surfaces the day your primary goes down is what this prevents.
- A member cannot repeat an earlier one exactly. The same provider **with a different model** is allowed and is a legitimate chain: a large model falling back to a smaller one.
- The chain cannot be empty.

If any of those fail, namzu names the offending position (`primary provider`, `fallback #1`, …) and re-opens the picker.

### Seeing the chain

`namzu doctor` prints it in order, one line per member, each carrying that member's position, label, the model it will use — marked `(namzu default)` when it came from namzu's registry rather than from your file — and whether a credential was found:

```
providers.chain  2 providers configured, in order:
                 1. primary · <label> · <model> · credential found
                 2. fallback 1 · <label> · <model> (namzu default) · NO CREDENTIAL
```

The label names whose choice it is on purpose. A model marked this way is one namzu picked, not one the provider reported, and nothing refreshes it between releases — so a member showing a model you did not expect is fixed by giving that member an explicit `model`, not by looking for the setting at the provider.

A fallback with no credential is a **warning**, not a failure — your primary still runs, so you are not blocked. A primary with no credential is a failure, because no run can start.

A purely local provider reports `reachable` / `NOT REACHABLE` instead, since it has no key to find.

The same check also reports whether the members **agree about what they can do**, which is the other way a chain with every credential in place still cannot run:

```
providers.chain  provider chain cannot be honoured as written:
                 1. primary · <label> · <model> · credential found
                 2. fallback 1 · <label> · <model> · credential found
                 The members declare different capabilities, so a session will be REFUSED:
                   - fallback #1 (<label>) declares it cannot read images, while primary provider (<label>) declares it can — if the chain falls over to it, image attachments stop reaching the model.
```

That is a **failure**, because a session refuses such a chain outright — see [when the members disagree](#when-the-members-disagree-about-what-they-can-do). If you have accepted the mismatch it is reported as a warning instead and still named, because it is still true.

A member whose declaration cannot be read at all — one with a registry entry but no construction path — is listed separately under `Could not read what these members declare`, and is not counted as a disagreement: an unanswered question is not a conflict.

Reading declarations means loading each member's driver, so this is the one check that pays for what it looks at.

### When a member cannot serve

If your primary fails a turn, namzu moves to the next member of the chain, keeps the conversation, and carries on from where it stopped. You are told, every time:

```
Provider chain: primary provider — Anthropic (Claude), claude-opus-4-7 — could not serve: HTTP 429, it rate limited this run and the retries did not clear it (rate_limit). fallback #1 — OpenAI, gpt-4o — is serving the rest of this turn.
```

That line goes into the transcript rather than a status indicator: it stays true for the rest of the turn, and someone reading the session back needs to know which answers came from which provider.

**What causes a fallover, and what does not.** The rule is that namzu moves on when the failure is a fact about the *provider*, and stops when it is a fact about your *request* — an identical request fails identically on the next provider, so trying it there would spend a second provider's money on the same error.

| The provider… | namzu… |
|---|---|
| rejected the credential (401 / 403) | moves on at once, without retrying — retrying a wrong key only spends the turn |
| does not have that model (404) | moves on at once |
| rate limited you (429) or failed (5xx) | retries first, and moves on only once the retry budget is spent |
| sent a `Retry-After` | waits as instructed; that is a transient wait, not a broken provider |
| returned something malformed | retries first, then moves on |
| said your prompt is too long | does **not** move on — namzu compacts and tries again on the same provider |
| rejected the request as invalid, or refused it | does **not** move on |

**Once an answer has started arriving, there is no fallover.** A stream that has already sent you text cannot be restarted elsewhere without repeating it, so a failure mid-answer is reported rather than swapped.

**The scope is the turn.** Your next message starts at your primary again. A rate limit at 14:00 does not quietly leave you on a cheaper model for the rest of the day.

**Each member is tried at most once per turn**, in the order you declared, and the whole chain is walked — declare four members and all four can be tried. When the chain is exhausted the last failure is reported as an ordinary error.

**A fallover is not free, and the cost is not obvious.** Providers charge less for a prompt they have already seen, and that cached prefix belongs to the provider that cached it. A different provider — or the same provider with a different model — has never seen this conversation, so the first request after a fallover re-reads your entire context at full price, and so does every request for the rest of the turn. On a long session that is the largest single cost of having a chain. It is a good reason to order the chain by what you would actually accept paying, and not to add members you do not want to be billed by.

**A fallback with no credential is left out of the chain**, and namzu says so at launch rather than at the moment you needed it:

```
Provider chain: fallback #1 (OpenAI) has no credential, so nothing will fall over to it. Set one of: OPENAI_API_KEY.
```

**Sub-agents do not inherit the chain.** A delegated task resolves its own provider — your primary — and does not follow a swap the parent made. A delegation is not your turn, and a sub-agent quietly announcing a provider change inside a tool result is worse than it failing and the parent telling you.

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
- It is about the chain, not about any one run. Capabilities are still negotiated once, against your **primary**, and that answer stays in force after a fallover — which is exactly why a disagreement is refused before a run starts rather than discovered during one. Each sentence says what happens *if the chain falls over*.

A member whose declaration cannot be read at all — a provider with no construction path yet — is reported as such rather than assumed to agree, and does not by itself refuse the chain.

You do not have to start a session to find any of this out. `namzu doctor` asks the same question of the same declarations — see [seeing the chain](#seeing-the-chain) — which is the point: the day to learn that your fallback is unusable is not the day your primary goes down.

### Upgrading from the previous format

A `version: 2` file (one `provider`, one optional `model`) is read as a one-member chain, so nothing needs doing. The file is rewritten in the new format the next time a choice is saved. A `version: 1` file is still refused and asks you to pick again.

### Overriding on the command line

`namzu run --provider <id>` **replaces** the chain for that run: the run uses exactly the provider you named and nothing else. An override that quietly kept your fallbacks could answer from a provider you did not name on that command line.

`--model <name>` on its own re-models the primary and leaves the rest of the chain in place.
