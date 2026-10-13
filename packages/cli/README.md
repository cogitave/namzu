<!-- okf
type: Reference
title: "@namzu/cli"
description: >-
  The terminal app for Namzu: install, first run, choosing a model, everyday
  use, scripts and scheduled jobs, with links into the full guide. Embedding
  notes for developers come last.
tags: [readme, package, cli, agent]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-01T00:00:00Z }
-->

# Namzu CLI

**An AI coding agent for your terminal. It reads and edits your project, runs commands, and asks before it acts.**

[![npm](https://img.shields.io/npm/v/@namzu/cli.svg)](https://www.npmjs.com/package/@namzu/cli)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://www.npmjs.com/package/@namzu/cli)

Install it, then start it in the folder you want to work on:

```sh
npm install -g @namzu/cli
cd your-project
namzu
```

You need Node.js 22.13 or newer. Other ways to install are under [Install](#install).

![Namzu edits a file in the terminal and shows the added lines](https://raw.githubusercontent.com/cogitave/namzu/main/packages/cli/assets/cli-editing.png)

## What you get

- **Work on real files.** Namzu reads, searches and edits the files in your folder and runs commands there. Tool results, approvals and progress appear next to your messages. [How tools run](https://github.com/cogitave/namzu/blob/main/docs/cli/tool-boundary.md)
- **Permission before action.** Each shell command goes through your permission rules and mode. A file outside your folder is an approval request, not a silent edit. [Where tools run](https://github.com/cogitave/namzu/blob/main/docs/cli/tool-boundary.md)
- **Undo a turn.** Namzu records each file before a tool changes it, so `/restore` puts the tree back as it was. [File checkpoints](https://github.com/cogitave/namzu/blob/main/docs/cli/file-checkpoints.md)
- **Split off independent work.** Start scoped agents for separate tasks, then watch their progress with `Ctrl+T`. [Delegated work](https://github.com/cogitave/namzu/blob/main/docs/cli/delegated-work.md)

![Two read-only agents working in parallel in the terminal](https://raw.githubusercontent.com/cogitave/namzu/main/packages/cli/assets/cli-agents.png)

- **Pick up where you left off.** Conversations are saved per project. Use `/resume` to choose one, or reopen one directly. [Session storage](https://github.com/cogitave/namzu/blob/main/docs/cli/session-storage.md)
- **Follow your conventions.** Skills load when the work needs them, and stored memory is recalled when it is relevant. [Skills](https://github.com/cogitave/namzu/blob/main/docs/cli/skills.md) · [Memory](https://github.com/cogitave/namzu/blob/main/docs/cli/memory.md)
- **Keep working while you are away.** Scheduled jobs run later, while Namzu is closed, under permissions you wrote down. [Scheduled tasks](https://github.com/cogitave/namzu/blob/main/docs/cli/scheduled-tasks.md)
- **Use it in scripts.** `namzu exec` runs one prompt and prints the answer. `namzu exec --json` streams events as they happen. [Headless exit codes](https://github.com/cogitave/namzu/blob/main/docs/cli/exec-exit-codes.md) · [Event stream](https://github.com/cogitave/namzu/blob/main/docs/cli/exec-json.md)

## Install

Install with npm, which works on macOS, Linux, WSL and Windows:

```sh
npm install -g @namzu/cli
namzu --version
```

Or use the installer for your shell. It checks your Node.js and npm, verifies that the binary answers, and does not install Node.js for you ([details](https://github.com/cogitave/namzu/blob/main/docs/cli/installation.md)).

On macOS, Linux or WSL:

```sh
curl -fsSL https://raw.githubusercontent.com/cogitave/namzu/main/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/cogitave/namzu/main/install.ps1 | iex
namzu.cmd --version
```

In the Windows Command Prompt, use `npm.cmd install --global @namzu/cli`, then run `namzu.cmd` in place of `namzu`. If an install fails, npm's diagnostic output stays on screen so you can read the cause. The PATH and reopen troubleshooting is in [Installing and reopening Namzu](https://github.com/cogitave/namzu/blob/main/docs/cli/installation.md).

To update later, `namzu upgrade --check` reports whether npm has a newer version, and `namzu upgrade` installs it.

## First run

Start Namzu in the folder you want it to work in:

```sh
cd ~/code/your-project
namzu
```

The session opens in that folder. Type a request and press Enter. Namzu shows what it reads, what it runs and each edit it proposes, and waits for your answer when a step needs your approval.

Before your first real task, check the host:

```sh
namzu doctor
```

`namzu doctor` reports what this machine can do: which providers have a usable sign-in or key, whether optional parts are installed, and what is missing. Add `--category providers` to see only the provider checks, or `--json` for a machine-readable report. [Provider credentials](https://github.com/cogitave/namzu/blob/main/docs/cli/credentials.md)

When you leave, Namzu prints a `namzu resume <conversation-id>` command. Run it in the same folder to reopen that conversation.

## Choose a model

Pick a model with `/model`. Press `p` in the picker to switch provider. The picker says whether your choice is saved for future launches, or applies only to this session. [Slash commands](https://github.com/cogitave/namzu/blob/main/docs/cli/slash-commands.md)

To start with a specific model for one session, use `--provider` and `--model` on `namzu`. [Launch flags](https://github.com/cogitave/namzu/blob/main/docs/cli/launch-flags.md)

You can connect a provider in four ways:

- **Reuse a sign-in you already have.** Namzu looks for sessions that your installed command-line tools already hold, and uses them without asking you to paste anything.
- **Sign in from Namzu.** Run `namzu login claude` or `namzu login codex`, or type `/login` in a session. `namzu logout codex` removes only the credential Namzu stored for you.
- **Use an API key.** Set the provider's variable, for example `OPENROUTER_API_KEY` for the `openrouter` provider, or paste a key in the picker. Most keys you paste there last for that session only; a Google key is saved for later launches.
- **Run a local model.** If a local model server is running on this machine, such as the `ollama` provider on its default port, the picker finds it and lists it. [Provider credentials](https://github.com/cogitave/namzu/blob/main/docs/cli/credentials.md)

The `zen` and `zen-go` providers appear in `/model` as separate providers.

- Without a key, `zen` lists free models that are meant to work without one. The hosted service may refuse such a request, and then you need a key. This path is experimental.
- For paid `zen` models, set `OPENCODE_API_KEY` or `OPENCODE_ZEN_API_KEY`. For `zen-go`, set `OPENCODE_GO_API_KEY`. `zen-go` uses `glm-5.3-flash` by default.
- Keys in the environment are read before any saved key.

```sh
namzu exec --provider zen-go --model glm-5.3-flash "Explain this project"
```

The rules for keys, the free-model path and the model list are in [Provider credentials](https://github.com/cogitave/namzu/blob/main/docs/cli/credentials.md) and [The model catalogue](https://github.com/cogitave/namzu/blob/main/docs/cli/model-catalogue.md).

## Everyday use

Type a request and press Enter. While a turn is running, you can keep typing:

- **Enter** sends a message that steers the running turn at its next safe point.
- **Tab** queues a message to run after the current turn.
- **Esc** interrupts the running turn. **Ctrl+C** exits.
- **Shift+Tab** cycles the permission mode between asking before changes, accepting edits, and plan (read-only).
- **Ctrl+T** opens or closes the view of delegated agents. **Ctrl+O** expands a tool's output, and opens a viewer for long output.
- **Ctrl+V** and **Alt+V** attach a clipboard image to the prompt.
- **Alt+W** drops, restores or arms the composer trigger nearest the cursor.

The full key list is in [Slash commands](https://github.com/cogitave/namzu/blob/main/docs/cli/slash-commands.md#keys-that-are-not-commands). Type `/help` to open the searchable command list, or `/help <command>` to read one command's usage.

These commands cover most sessions:

| Command | What it does |
|---|---|
| `/model` | Choose a model, and its reasoning effort where supported. |
| `/login`, `/logout` | Sign in to, or remove, a Namzu-owned subscription. |
| `/permissions` | Choose between asking before changes, auto-approving edits, and plan mode. |
| `/resume` | Choose a saved conversation in this project. |
| `/fork` | Continue in a copy of this conversation. |
| `/worktree` | Create a managed Git worktree for a separate checkout. |
| `/skills` | Activate a skill for this conversation. |
| `/review` | Review uncommitted work, a branch or a commit. |
| `/memory` | Show what Namzu remembers for this project. |
| `/status` | Show the model, permissions, workspace and latest cost. |
| `/cost` | Show usage and cost for the current or last turn. |
| `/export` | Save the conversation as Markdown, to the clipboard or a file. |
| `/archive` | Make this conversation read-only and exit. |

Every command, with its options, is in [Slash commands](https://github.com/cogitave/namzu/blob/main/docs/cli/slash-commands.md).

**Permissions and the sandbox.** By default, tools run on your machine under the permission system. The OS sandbox is opt-in: set `sandbox.enabled: true` in your configuration file. [Where tools run](https://github.com/cogitave/namzu/blob/main/docs/cli/tool-boundary.md). To let file tools reach another folder for one session, start with `--add-dir <path>`.

**Project instructions.** `/init` writes an `AGENTS.md` that describes the project to future agents. [Slash commands](https://github.com/cogitave/namzu/blob/main/docs/cli/slash-commands.md)

**Tool servers and plugins.** External tool servers are configured with `mcpServers` and checked with `/mcp`. Plugins are off by default and turn on with `plugins.enabled: true`. [Tool servers](https://github.com/cogitave/namzu/blob/main/docs/cli/mcp-servers.md) · [Plugins](https://github.com/cogitave/namzu/blob/main/docs/cli/plugins.md)

**Where Namzu keeps its data.** Namzu keeps its state under `~/.namzu`, or under the directory named by `NAMZU_HOME` if you set it. Its own state and conversation records stay out of your project folder. `namzu state` lists that state without changing it. [Session storage](https://github.com/cogitave/namzu/blob/main/docs/cli/session-storage.md)

## Scheduled jobs

A scheduled job is a prompt that runs later in a folder while Namzu is closed. You choose its permissions when you create it. A call the job does not allow waits for you, or is refused. It is never approved on its own.

```sh
namzu schedule install
namzu schedule add nightly-deps --prompt "Check for outdated dependencies." \
  --when "0 3 * * *" --permissions read-only
namzu schedule status
```

`namzu schedule install` sets up the scheduler service for your user. Each run is a conversation you can open with `/resume`, and it may send a desktop notification and adds a line to the job's history. A job takes effect only after a person confirms it, in a terminal or with `/schedule`. A job created with `--yes` from a script waits, inert, until someone confirms it. The permission presets, the scheduler service on each platform, and how missed runs are handled are in [Scheduled tasks](https://github.com/cogitave/namzu/blob/main/docs/cli/scheduled-tasks.md) and [The scheduler service](https://github.com/cogitave/namzu/blob/main/docs/cli/scheduler-service.md).

## Scripts and headless use

`namzu exec` runs one prompt without the interactive screen. Use it in scripts, cron jobs and CI:

```sh
namzu exec "fix the failing test"
namzu --format json exec "list the public exports of this package"
namzu exec --json "refactor the parser" > events.ndjson
namzu exec --output-schema answer.schema.json "rate this diff from 1 to 5"
```

- `namzu exec` (alias `namzu e`) prints the final answer on stdout. Logs go to stderr, so stdout stays clean for the next command.
- `--json` writes one JSON event per line as the turn runs, so a script can react before the turn ends. The event kinds are in [namzu exec --json](https://github.com/cogitave/namzu/blob/main/docs/cli/exec-json.md).
- `--output-schema <file>` makes the final answer match a JSON Schema you provide. Pass it after `exec`.
- `--format json` (or `yaml`) on the root command switches the output of `namzu state` and `namzu exec` to that format. `--verbose` and `--quiet` also go before the command.
- `--provider` and `--model` choose the model for one run, as shown in [Choose a model](#choose-a-model).

Exit codes matter in scripts. The main ones: `1` means the turn failed, `2` means no prompt was given, `64` means a wrong argument, `75` means try again later (the provider paused the turn, or the session already has a turn running), and `77` means the folder is not trusted yet, so trust it once in the interactive session. The full list is in [Exit codes of namzu exec](https://github.com/cogitave/namzu/blob/main/docs/cli/exec-exit-codes.md).

`namzu run` and `namzu run-stream` were removed. `namzu exec` and `namzu exec --json` take the same options.

## Requirements

- **Node.js 22.13 or newer.** The package declares this in its `engines` field.
- **macOS, Linux, WSL, or Windows** through PowerShell or the Command Prompt. Commands for each shell are in [Install](#install).
- **A sign-in or an API key** for the provider you want to use. `namzu doctor` tells you which are missing.

## Status

The terminal app is published on npm as `@namzu/cli`. Versions follow semantic versioning: a change that breaks the public interface is a major version. Read the [changelog](https://github.com/cogitave/namzu/blob/main/packages/cli/CHANGELOG.md) before you upgrade across a major version. Run `namzu upgrade --check` to see whether a newer version is out.

## For developers

`@namzu/cli` is also a library. It exposes `runCli` and `runDoctorCommand`, the doctor registry (`registerDoctorCheck`, `runDoctor`), `probeCapabilities`, and the command types, so a host can embed the terminal app or add its own checks. The package builds on [`@namzu/sdk`](https://github.com/cogitave/namzu/blob/main/docs/sdk/index.md), the kernel that runs the agents. To build an agent without the terminal app, start with the SDK guide.

## Documentation

- [Terminal app guide](https://github.com/cogitave/namzu/blob/main/docs/cli/index.md): every page about the app, one line each.
- [Installing and reopening Namzu](https://github.com/cogitave/namzu/blob/main/docs/cli/installation.md)
- [Slash commands](https://github.com/cogitave/namzu/blob/main/docs/cli/slash-commands.md) and [Launch flags](https://github.com/cogitave/namzu/blob/main/docs/cli/launch-flags.md)
- [Scheduled tasks](https://github.com/cogitave/namzu/blob/main/docs/cli/scheduled-tasks.md)
- [namzu exec --json](https://github.com/cogitave/namzu/blob/main/docs/cli/exec-json.md)
- [Project root README](https://github.com/cogitave/namzu/blob/main/README.md)

## License

`@namzu/cli` is published under the MIT license.
