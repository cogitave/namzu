---
type: Reference
title: Flags for one run
description: --append-system-prompt, --allowed-tools, --disallowed-tools, --fallback-model and --max-budget-usd on namzu exec and the interactive session; where each goes in the prompt, how each combines with the config, and what a bad value does.
resource: packages/cli/src/commands/run-flags.ts
tags: [cli, headless, permissions, providers, limits]
status: stable
generated: { by: human:bahadirarda, at: 2026-10-27T00:00:00Z }
---

# Flags for one run

Five options change what a single run does without touching a config file. They are read the same way by `namzu exec`, `namzu exec --json` and the interactive `namzu` (written before the command there), so a script and a person at the keyboard get the same behaviour. None of them is saved.

```sh
namzu exec --append-system-prompt "Answer in one paragraph." "why did the build fail"
namzu exec --allowed-tools "edit bash(git status*)" --disallowed-tools "bash(rm *)" "tidy the imports"
namzu exec --fallback-model openai/gpt-5.5,claude-haiku "triage the failing tests"
namzu exec --max-budget-usd 2.50 "port the parser"
namzu --append-system-prompt @team-rules.md --allowed-tools "edit read"
```

| Flag | On `exec` | On `namzu` (before the command) |
| --- | --- | --- |
| `--append-system-prompt <text\|@file>` | yes | yes |
| `--allowed-tools <list>` | yes, repeatable | yes, repeatable |
| `--disallowed-tools <list>` | yes, repeatable | yes, repeatable |
| `--fallback-model <provider/model[,…]>` | yes, repeatable | yes, repeatable |
| `--max-budget-usd <amount>` | yes | refused: it stops a headless run, so it is written after `exec` |

Written before `exec`, `drain` or any other subcommand they are refused with exit status 64 and a line saying where they go. `namzu resident` refuses all five, since a resident step does not read them.

## Appended instructions

`--append-system-prompt` adds standing instructions to every turn of the run. A value starting with `@` names a file to read (relative to the folder you ran the command from), so a long set of rules lives in a file; anything else is the text itself. The text is trimmed and may be up to 100,000 characters. An empty value, an unreadable file or a folder is refused before anything starts, with the flag named.

The text goes in the **uncached tail** of the system prompt, after everything the provider's prompt cache keeps, so passing it never costs a cache miss on the shared part: the prompt of a run with the flag begins with exactly the prompt of a run without it. It carries the weight of an instruction from the person running Namzu, like project instructions do; it is not shown in the transcript. Delegated agents do not inherit it.

## Tool lists

`--allowed-tools` and `--disallowed-tools` take tool entries separated by commas or spaces. An entry is a tool name (`edit`) or a tool name with a pattern in brackets (`bash(git status*)`), the same patterns a `[permissions]` table takes, so `bash(git push*)` matches a command that starts with `git push`. Commas and spaces inside the brackets are part of the pattern. Built-in tool names are written in lower case (`Edit` is read as `edit`); a tool from a tool server keeps its exact name (`mcp__files__read`). Repeat the flag to add more entries.

The lists are **two more layers on top of the ones in your config**, never a replacement: a rule that denies a call in any layer still denies it, a rule that asks still asks, and `--allowed-tools` only settles the calls nothing stricter decided. So `--allowed-tools bash` does not open a command your config denies, and `--disallowed-tools` is the way to close something for one run. The dangerous-command check stays on in every mode. An entry that cannot be read (a bracket never closed) is refused, naming the flag, rather than dropped, because a rule you believe is in force must not quietly be missing. See [Permission layers](permission-layers.md) for how layers combine.

## Fallback models

`--fallback-model` names the models a run may fall over to, in order, when the one before it cannot answer (a busy provider, an outage, a rejected sign-in). It builds the same chain `providers.chain` does, for this run only. Each entry reads as:

| Entry | Means |
| --- | --- |
| `openai/gpt-5.5` | that model on that provider, when the part before the first `/` is a provider Namzu knows |
| `openai` | that provider's own default model |
| `claude-haiku` (or `meta/llama-4`) | that model on the same provider as the first |

Commas inside a value and repeated flags both add entries. The chain is the run's first provider (saved, or `--provider`/`--model`) followed by these, and it **replaces the fallbacks you saved**: a provider you did not name cannot answer in their place, the same rule `--provider` follows. An entry that repeats one already in the chain is dropped. Members whose abilities differ are refused in the usual way unless the saved preferences accept the mismatch, and a member with no credential is left out with the usual notice.

A fallback lasts for the rest of that reply only. The next reply starts again with the run's first model, and that model gets its usual retries before the chain moves on, so a model that is down is tried first on every reply. When a fallback takes over, the run says which model is answering: `Anthropic (claude-opus-4-7) was too busy, so Namzu used Anthropic (claude-haiku-4-5) for the rest of that reply.` It is a transcript row in the session, a status line on stderr for `exec`, and a `provider-fallback` event in `exec --json`. The model that took over is always named; the one that gave up is named too only when the same provider took over, since two products already tell the sides apart.

## Spend limit

`--max-budget-usd <amount>` stops a headless run when its priced spend reaches the amount; it takes a number above zero. A delegated agent is held to the full amount on its own, so a run that delegates can spend more than the amount in total. See [Turn limits](turn-limits.md#spend-limit) for what is counted, the exit code and what happens with a model that has no price.
