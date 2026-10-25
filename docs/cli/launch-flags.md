---
type: Reference
title: Launch flags for the interactive session
description: --provider, --model, --effort, --permission-mode, --message, --continue and --resume on the interactive namzu and namzu resume, what each chooses for that launch only, how they combine with the saved choice and --yolo, the switch that lets Shift+Tab reach bypass, and what happens when one cannot be honoured.
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

`namzu resume` takes the conversation id printed when Namzu last exited; with no id it opens the list of this folder's conversations, the same list `--resume` with no value opens.

Four options choose how one interactive session starts. They are written **before** the command name (`namzu resume` is the one command that takes them) and they are **session-only**: nothing is written to `preferences.json`, so the next plain `namzu` starts on whatever you last picked in the app. Inside the session `/model`, `/effort` and `/permissions` work as they always do and replace the launch choice.

| Flag | Chooses | Values |
| --- | --- | --- |
| `--provider <id>` | the provider for this launch | an id from the provider list |
| `--model <id>` | the model for this launch | a model id the provider offers |
| `--effort <level>` | the reasoning effort | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `--permission-mode <mode>` | the permission mode | `prompt`, `accept-edits`, `plan`, `bypass`, `auto`, `strict` ([Permission modes](permission-modes.md)) |

Two switches change what Shift+Tab may reach rather than where the session starts. `--dangerously-skip-permissions` (alias `--yolo`) starts in `bypass`, and `--allow-dangerously-skip-permissions` keeps the launch mode but lets Shift+Tab and `/permissions` reach `bypass`; the cycle is `prompt`, `accept-edits`, `plan`, then `bypass` (only when the launch allowed it), then `auto` (unless `permissions.disableAutoMode` is set), then `prompt`. `--permission-mode bypass` counts as launching in `bypass`. `--permission-mode auto` is the classifier mode, not the old no-prompt one. A launch the settings or the root guard forbid (`permissions.disableBypassMode`, bypass as the superuser outside a sandbox) is refused with exit status 64 and a plain sentence. The first time a launch starts in `bypass` it asks `Start in bypass mode? [y/N]` once; a no starts in the ordinary mode. `--allow-dangerously-skip-permissions` is for the interactive session only; `namzu exec` does not take it.

A fifth, `--message <text>`, is the first message of the launch: the session sends it once, as a plain prompt (a leading `/`, `!` or `#` is text, not a command), as soon as the composer is ready, and the turn runs with the provider, model, effort and mode chosen above. It is shown as the first user message, is kept in the composer's history, and is never sent again by a later `/resume`, reload or re-login. Pass it as `--message=<text>` when the text may begin with a dash. It is refused before a subcommand like the others, and before `resume` (exit 64): a resumed conversation never gets a first message.

The same four flags exist on `namzu exec` and `namzu drain`, written after the command, where they apply to that run. Written before `exec`, `drain` or any other subcommand they are refused with exit status 64 and a line naming where they go, so a flag is never silently ignored.

## Picking up a conversation: `-c` and `-r`

```sh
namzu -c                      # the most recent conversation in this folder
namzu --resume                # the /resume picker
namzu --resume "billing fix"  # the conversation with exactly that title
namzu -r 11de68ce-02f2-49e4-a7e4-7f29355d7aaf
```

These apply to the interactive session only (the same flags on `namzu exec` are separate and refuse rather than open a picker). `-c` / `--continue` opens the most recent conversation in this folder, and says so and exits 64 when there is none. `-r` / `--resume` with no value opens the `/resume` picker as soon as the composer is ready. With a value shaped like a conversation id it resumes that conversation or refuses with the cause; with any other value it resumes the one conversation whose title is exactly that, and otherwise opens the picker with the value as a search (case-insensitive, over the title and the opening message), or says nothing matched. Passing both is refused, and so is either flag before a subcommand or before `resume`. `--resume` takes the next word as its value, so write `namzu -c resume <id>` rather than `namzu --resume resume`; a value that begins with a dash needs `--resume=<value>`.

## How they combine with what is saved

- **`--provider`** replaces the provider chain with that provider alone, so a fallback you saved cannot answer in its place. With `--model` it names that provider's model; without it the provider chooses its own default.
- **`--model` alone** re-models the saved primary provider and keeps the saved fallbacks behind it. With nothing saved there is no provider to apply it to: the provider list opens and says so.
- **`--permission-mode`** names the starting mode outright and wins over `--yolo` / `--dangerously-skip-permissions`, which in turn win over `permissions.defaultMode`. The status report (`/permissions`, `/status`) says the mode was selected at launch, or by the configuration.
- **`--effort`** applies to the first session the launch opens. A level the chosen model does not offer is reported (`--effort high is not offered by <model>; using the provider default.`) and the default stays; the levels a model offers are the ones `/effort` lists.

## When a launch cannot be honoured

An unknown provider, or one the session cannot start on, does not leave an unusable session: the provider list opens with the reason in plain words (`nopeai is not a provider Namzu knows. Choose one from the list below.`, or `Couldn’t start with <Provider> and <model>.`), and picking from it is an ordinary choice. A `--model` the provider does not list starts the session and says once that replies will fail until another model is picked with `/model`. An invalid `--effort` or `--permission-mode` value is refused before anything starts, with the values it takes and a pointer to `namzu --help`.

`--debug` (or `NAMZU_DEBUG=1`) shows the technical text that the terminal app otherwise keeps out of sight: the provider's structured error under a failed reply, the cause behind a failure the app could not explain, and the stack of a crash.

## Environment markers

The terminal app draws live in a terminal even when the shell exports `CI` or a similar marker; only its own drawing is affected, and the commands the agent runs still see the same variables. With output or input piped, the usual detection applies.

## The desktop's terminal tabs

The Desktop's "CLI" surface for the Namzu engine starts this same command in a terminal tab with the composer's choices as these flags, and the composer's text as `--message=`, which is why they are session-only: the person's saved preferences are theirs, and a tab started for one task must not rewrite them. See [Desktop](desktop.md#host-terminals).
