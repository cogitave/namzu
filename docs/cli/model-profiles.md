---
type: Reference
title: Process-local model profiles
description: Environment defaults for the main model, delegated and side models, effort, output allowance and automatic compaction.
resource: packages/cli/src/config/model-environment.ts
tags: [cli, providers, config, environment]
status: stable
---

# Process-local model profiles

A shell can select the models and budgets for one Namzu process without editing
its saved provider preferences. Credentials and endpoint variables belong to the
selected driver, such as `OPENAI_API_KEY` and `OPENAI_BASE_URL` for an
OpenAI-compatible endpoint. No model-name mapping is added merely by setting a
different endpoint.

| Variable | Meaning |
| --- | --- |
| `NAMZU_PROVIDER` | Primary provider, unless `--provider` is given. |
| `NAMZU_MODEL` | Exact primary model id, unless `--model` is given. |
| `NAMZU_EFFORT_LEVEL` | Default reasoning effort, unless `--effort` is given. Case-insensitive; `med` is `medium`; `auto` and `unset` mean no override (the model's own default). On DeepSeek, `max` is carried as the vendor's `reasoning_effort`; a level the model does not offer is mapped to the nearest one it does. Ordinary children also receive this default; their explicit or file-defined effort wins. |
| `NAMZU_SMALL_MODEL` | Side-job model, replacing `smallModel` for this process. Accepts a bare id or `provider/model`. |
| `NAMZU_SUBAGENT_MODEL` | Default model for ordinary delegated agents, as a bare id on the parent's provider or `provider/model`. Explicit child choices and pinned agent files win; a fork retains its parent model. |
| `NAMZU_MAX_OUTPUT_TOKENS` | Positive safe-integer output allowance per call, including reasoning. `--max-output-tokens` wins. |
| `NAMZU_AUTO_COMPACT_WINDOW` | Window used for automatic summaries: a plain number or one with a `k`/`m` suffix (`786k`, `200000`, `1m`), clamped to 100k..1M with a one-line warning, a non-size ignored with a warning. Capped to the actual model context (the smaller of the two wins); it cannot declare a larger context. |
| `NAMZU_DISABLE_1M_CONTEXT` | `1`, `true`, `yes` or `on`: a model id ending in `[1m]` stops declaring a million-token window, and no window above 200,000 is assumed from a driver or the table. |

Main provider/model/effort exports apply to interactive launches and both
`exec` output modes. They are launch defaults, not saved preferences or a
replacement for a paused turn's recorded state. An exported model does not
become a misplaced root flag on commands such as `history` or `upgrade`.
Unknown effort levels and invalid token sizes are refused with the setting's
name. A syntactically valid effort still needs support from the chosen model;
capabilities come from its driver and catalogue.

For example, after exporting the selected driver's credential and endpoint:

```bash
export NAMZU_PROVIDER=openai
export NAMZU_MODEL=my-main-model
export NAMZU_SMALL_MODEL=openai/my-small-model
export NAMZU_SUBAGENT_MODEL=openai/my-child-model
export NAMZU_EFFORT_LEVEL=high
export NAMZU_MAX_OUTPUT_TOKENS=32768
export NAMZU_AUTO_COMPACT_WINDOW=786432
namzu
```

Use the endpoint's actual model identifiers. One suffix is Namzu's own: an id
ending in `[1m]` (any case) declares a one-million-token window for any model,
recognised or not, and is removed before the id reaches a driver or a wire.
`--model`, `/model`, `NAMZU_MODEL`, `NAMZU_SUBAGENT_MODEL`, `NAMZU_SMALL_MODEL`
and the config file all honour it, and the UI shows the id as written:

```bash
export NAMZU_PROVIDER=deepseek
export NAMZU_MODEL='deepseek-flash[1m]'
export NAMZU_SUBAGENT_MODEL=deepseek-flash
export NAMZU_EFFORT_LEVEL=max
export NAMZU_AUTO_COMPACT_WINDOW=786k
```

An explicit `compaction.contextWindowTokens` outranks the suffix. Other
suffixes another application's model resolver interprets are not part of any
identifier here. Tier aliases such as an opus or sonnet name have nothing to
remap in Namzu: models are named directly, a model per role is the pair
`NAMZU_SUBAGENT_MODEL` and `NAMZU_SMALL_MODEL`.

The output and compact-window exports overlay only their matching member of
`limits` and `compaction`; file-defined turn guards and compaction strategy are
preserved. Managed config retains its final place in the file/environment
cascade. The source viewer records the last contributor to a composite field;
it does not attribute every nested member separately. An automatic-summary
window retains the normal output reserve, buffer and salience soft target; see
[context limits](../sdk/context-limits.md#the-summary-trigger).

## An Anthropic-compatible endpoint

`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` are the vendor SDK's own
variables and the Anthropic provider honours both. When the base URL is not the
vendor's own host, the token is sent as a plain bearer credential, the vendor's
subscription headers and identity system block are not sent, and the model's
window comes from its id (with `[1m]`), not from any vendor catalogue. A saved
sign-in or detected key is never sent to another host. Without
`ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` a third-party base URL (and one
that is not a URL) is ignored with a notice at launch, and requests go to the
vendor's own host as before; `ANTHROPIC_AUTH_TOKEN` is read only together with a
third-party base URL and is not a detected sign-in. `/status` shows the provider as `Anthropic (Claude) via <host>`.
A base URL on the vendor's host, or none, behaves as before. For a non-Claude
id the menu is `low`, `high` and `max`.

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=...
export NAMZU_PROVIDER=anthropic
export NAMZU_MODEL='deepseek-flash[1m]'
```

The native `deepseek` provider reaches the same models without these variables
and is the simpler route.

## Variables some other tools use

| Variable some other tools use | Namzu equivalent |
| --- | --- |
| a main-model variable | `NAMZU_MODEL` (or `--model`, `/model`) |
| per-tier default-model variables for large and medium models | none: models are named directly, so set `NAMZU_MODEL` (and `NAMZU_SUBAGENT_MODEL` for delegates) |
| a default-model variable for the small tier | `NAMZU_SMALL_MODEL` |
| a sub-agent model variable | `NAMZU_SUBAGENT_MODEL` |
| an effort-level variable | `NAMZU_EFFORT_LEVEL` |
| an auto-compact window variable | `NAMZU_AUTO_COMPACT_WINDOW` |
| a switch that disables the 1M suffix | `NAMZU_DISABLE_1M_CONTEXT` |
| a base-URL and an auth-token variable | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (the vendor SDK's own) |
