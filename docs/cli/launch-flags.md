---
type: Reference
title: Launch flags for the interactive session
description: --provider, --model, --effort, --permission-mode and --message on the interactive namzu and namzu resume, what each chooses for that launch only, how they combine with the saved choice and --yolo, and what happens when one cannot be honoured.
resource: packages/cli/src/tui/launch-settings.ts
tags: [cli, tui, providers, permissions]
status: stable
generated: { by: human:bahadirarda, at: 2026-10-08T00:00:00Z }
---

# Launch flags for the interactive session

```sh
namzu --provider openai --model gpt-5 --effort high --permission-mode plan
namzu --model gpt-5                # re-model the saved primary for this launch
namzu --permission-mode accept-edits resume <conversation-id>
```

Four options choose how one interactive session starts. They are written **before** the command name (`namzu resume` is the one command that takes them) and they are **session-only**: nothing is written to `preferences.json`, so the next plain `namzu` starts on whatever you last picked in the app. Inside the session `/model`, `/effort` and `/permissions` work as they always do and replace the launch choice.

| Flag | Chooses | Values |
| --- | --- | --- |
| `--provider <id>` | the provider for this launch | an id from the provider list |
| `--model <id>` | the model for this launch | a model id the provider offers |
| `--effort <level>` | the reasoning effort | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `--permission-mode <mode>` | the permission mode | `prompt`, `accept-edits`, `auto`, `strict`, `plan` |

A fifth, `--message <text>`, is the first message of the launch: the session sends it once, as a plain prompt (a leading `/`, `!` or `#` is text, not a command), as soon as the composer is ready, and the turn runs with the provider, model, effort and mode chosen above. It is shown as the first user message, is kept in the composer's history, and is never sent again by a later `/resume`, reload or re-login. Pass it as `--message=<text>` when the text may begin with a dash. It is refused before a subcommand like the others, and before `resume` (exit 64): a resumed conversation never gets a first message.

The same four flags exist on `namzu exec` and `namzu drain`, written after the command, where they apply to that run. Written before `exec`, `drain` or any other subcommand they are refused with exit status 64 and a line naming where they go, so a flag is never silently ignored.

## How they combine with what is saved

- **`--provider`** replaces the provider chain with that provider alone, so a fallback you saved cannot answer in its place. With `--model` it names that provider's model; without it the provider chooses its own default.
- **`--model` alone** re-models the saved primary provider and keeps the saved fallbacks behind it. With nothing saved there is no provider to apply it to: the provider list opens and says so.
- **`--permission-mode`** names the starting mode outright and wins over `--yolo` / `--dangerously-skip-permissions`. The status report (`/permissions`, `/status`) says the mode was selected at launch.
- **`--effort`** applies to the first session the launch opens. A level the chosen model does not offer is reported (`--effort high is not offered by <model>; using the provider default.`) and the default stays; the levels a model offers are the ones `/effort` lists.

## When a launch cannot be honoured

An unknown provider, or one the session cannot start on, does not leave an unusable session: the provider list opens with the reason (`Could not start with <provider> / <model>: …`), and picking from it is an ordinary choice. An invalid `--effort` or `--permission-mode` value is refused before anything starts, with the values it takes.

## Environment markers

The terminal app draws live in a terminal even when the shell exports `CI` or a similar marker; only its own drawing is affected, and the commands the agent runs still see the same variables. With output or input piped, the usual detection applies.

## The desktop's terminal tabs

The Desktop's "CLI" surface for the Namzu engine starts this same command in a terminal tab with the composer's choices as these flags, and the composer's text as `--message=`, which is why they are session-only: the person's saved preferences are theirs, and a tab started for one task must not rewrite them. See [Desktop](desktop.md#host-terminals).
