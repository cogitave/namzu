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
| `NAMZU_EFFORT_LEVEL` | Default reasoning effort, unless `--effort` is given. Ordinary children also receive this default; their explicit or file-defined effort wins. |
| `NAMZU_SMALL_MODEL` | Side-job model, replacing `smallModel` for this process. Accepts a bare id or `provider/model`. |
| `NAMZU_SUBAGENT_MODEL` | Default model for ordinary delegated agents, as a bare id on the parent's provider or `provider/model`. Explicit child choices and pinned agent files win; a fork retains its parent model. |
| `NAMZU_MAX_OUTPUT_TOKENS` | Positive safe-integer output allowance per call, including reasoning. `--max-output-tokens` wins. |
| `NAMZU_AUTO_COMPACT_WINDOW` | Positive safe-integer window used for automatic summaries. Capped to the actual model context; does not declare a larger provider context. |

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

Use the endpoint's actual model identifiers. Suffixes another application's
model resolver interprets are not automatically part of those identifiers.

The output and compact-window exports overlay only their matching member of
`limits` and `compaction`; file-defined turn guards and compaction strategy are
preserved. Managed config retains its final place in the file/environment
cascade. The source viewer records the last contributor to a composite field;
it does not attribute every nested member separately. An automatic-summary
window retains the normal output reserve, buffer and salience soft target; see
[context limits](../sdk/context-limits.md#the-summary-trigger).
