<!-- okf
type: Reference
title: "@namzu/cli"
description: >-
  A terminal coding agent built on the Namzu kernel, from the same public API
  you get. Interactive sessions, headless runs that stream structured events,
  and a doctor that reports what the host can actually do.
tags: [readme, package, cli, agent]
timestamp: 2026-08-24T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/cli</h1>

**A terminal coding agent, built on [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk).**

[![npm](https://img.shields.io/npm/v/@namzu/cli.svg)](https://www.npmjs.com/package/@namzu/cli)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Headless](#headless-runs) · [Documentation](#documentation)

</div>

---

A terminal coding agent built entirely on the Namzu kernel, in the same
repository, from the same public API you get. It exists as much to prove the
kernel as to be used: every gap in the SDK showed up first as something the CLI
had to work around.

## Install

```bash
npm install -g @namzu/cli     # the binary
npx @namzu/cli                # or run it once without installing
```

Requires Node.js 20+.

There is also an installer, which checks the Node version, installs the package
and then verifies the binary answers before claiming success. If the global
prefix is not writable it retries into `~/.namzu` and names the one line to add
to your profile; it never re-runs itself with elevated privileges.

```bash
curl -fsSL https://raw.githubusercontent.com/cogitave/namzu/main/install.sh | sh
# Windows
irm https://raw.githubusercontent.com/cogitave/namzu/main/install.ps1 | iex
```

Installing brings the kernel and five model drivers — Anthropic, OpenAI,
DeepSeek, OpenRouter and Ollama — plus `@namzu/files` and
`@namzu/computer-use`, as ordinary dependencies rather than peers. So a fresh
install can already reach those services and expose desktop control when the
device has a supported adapter. `@namzu/telemetry` and `@namzu/sandbox` remain
optional capabilities that `namzu doctor` probes for.

## Usage

```bash
namzu                       # interactive session in the current directory
namzu resume ses_...        # reopen the exact interactive conversation printed on exit
namzu doctor                # what this host can actually do, and what is missing
namzu upgrade --check       # check npm without changing the installation
namzu upgrade               # update this active npm-global installation
namzu login claude          # create a Namzu-owned Claude subscription session
namzu login codex           # create a Namzu-owned ChatGPT subscription session
namzu logout codex          # remove only Namzu's stored Codex subscription
```

The TUI checks npm briefly after startup and prints `namzu upgrade` when a
newer CLI is available. Upgrade derives the prefix from the package that is
actually running, installs the exact registry version there, and reads that
same package back before reporting success. It refuses local checkouts and
unknown package-manager layouts instead of guessing at another binary on
`PATH`; update those with the package manager that installed them.

Desktop control is separate from attaching a clipboard image. Ctrl+V/Alt+V
adds an image to the current prompt; the TUI's `computer_use` tool lets the
model take a fresh screenshot and, after the normal permission decision, drive
pointer or keyboard input. Namzu mounts that tool only when the host adapter
initializes. Unattended `run`, `run-stream` and `drain` do not mount it because
they have no interactive permission owner. Inside WSL the TUI targets the
paired Windows desktop through `powershell.exe`, so WSLg display variables do
not incorrectly select a Linux compositor adapter.

On startup, Namzu first reuses usable `Claude` and `Codex` sessions already owned
by their installed command-line clients, including the paired Windows home from
WSL. With no saved choice, one signed-in subscription starts directly; if both
are available, a narrowed picker asks which one to use and proceeds with its
default model. Codex credentials remain read-only. If an expired `Claude` session
must rotate its refresh grant, Namzu preserves the complete owner envelope and
publishes the successor pair back to that exact file so `Claude` is not logged
out. A Namzu-owned sign-in is needed only when no usable device session exists
or when you explicitly want a separate login; its `Claude` route uses direct
subscription authorization rather than API-usage billing, and its returned
authorization code can be pasted back into the same picker that started it.
Bare `/login` lists those operations separately: reusable device sessions are
labelled `Use existing`, while new credentials are labelled `Sign in to`. An
expired or signed-out owner session is not offered as reusable.
API keys remain optional alternatives through environment variables or the
session-only credential picker, and detecting one does not hide the subscription
sign-in action.

Bare `/effort`, `/permissions`, `/feedback`, `/skill`, and `/review` open finite
keyboard choosers. The review chooser can target a base branch, uncommitted
work, or a recent commit; choosing custom instructions restores `/review ` to
the composer. When both Namzu-owned subscriptions exist, bare `/logout` asks
which one to remove. `/logout claude|codex|all` and
`namzu logout claude|codex|all` remain exact non-interactive forms, and never modify device
sessions owned by another tool. A fully typed
command is the active completion ahead of longer names with the same prefix, so
`/skill` cannot accidentally run `/skills`. Long model and resume lists
keep a seven-row window around the active choice and show its absolute position.
Finite labels grow into available terminal width, so branch names and commit
subjects are not forced through the same narrow column. Arrow navigation never
moves the selection beyond the visible terminal. The
footer keeps `model effort · cwd` on the left and reserves the right edge for a
state-specific interaction or durable goal state. Idle conversation leaves the
key legend to `/help` instead of repeating it on every frame.

While a turn runs, Return steers that turn at the next model-safe response
boundary and Tab queues a separate follow-up; at idle either key starts the
draft. Ctrl+V and Alt+V attach a clipboard image, independently of the optional
computer-use package. Left/Right and Ctrl+B/Ctrl+F move by complete displayed
characters, Home/End and Ctrl+A/Ctrl+E move to line boundaries, and
Ctrl+W/Ctrl+U/Ctrl+K delete around the live cursor, and Ctrl+Y restores the
last non-empty deletion at the cursor even after submitting. Ctrl+H and
Backspace each remove one displayed character. Ctrl+J, Shift+Enter and
Alt+Enter add a newline; Up/Down and Ctrl+P/Ctrl+N move between authored lines
before crossing into prompt history, where returning to the newest entry
restores the unsent draft. Ctrl+R searches matching prompts from newest to
oldest, Ctrl+S walks back toward the draft, and Esc restores the exact text and
cursor that started the search. Direct shell resume and the in-TUI resume
picker add restored operator-authored prompts to this history while keeping
runtime context and automatic goal turns out. Alt+B/F and modified arrows move by words,
Alt+Backspace/Alt+D delete words, and Ctrl+D deletes the next complete
displayed character. Conversation rows flow
downward from the banner while unused viewport
space stays below the transcript, and the slash palette scrolls through every
matching command while using the remaining terminal width for descriptions.
Its position line makes the full result count visible; PageUp/PageDown jump by
a window and Home/End reach the boundaries. Menu input and selection are
synchronous, so `/`, navigation and Enter may arrive in one terminal burst
without losing the chosen command. The same page and boundary keys work in
model, resume, review, skill, copy and other finite command choosers; their
Enter action also follows the newest cursor when navigation arrives in the
same terminal burst. On
clean exit the CLI prints a copy-pasteable `namzu resume <id>` command; buffered
boot and sandbox diagnostics are reserved for crashes.

Repository policy stays live for the whole session. The CLI starts with the
applicable `AGENTS.md` chain, discovers nested instruction files after
successful reads, writes and edits, and labels every file with its directory
scope. The current snapshot is retained in durable model context, while a
resumed session uses its validated project-relative paths to re-read the files
from disk instead of trusting stale saved prose.

Executable SDK plugins are available but default off. Opt in from a config file
with `plugins.enabled: true`, then restrict discovery to `project`, `user`, or
both scopes. Project plugins are not read before the project trust gate, and
plugin paths are canonicalized against the trusted project or user-home root;
links that leave that scope and symlinked manifests are refused. Plugin
settings cannot be activated by an environment-selected profile. The
same plugin hooks and skills reach interactive turns, headless runs, durable
resumes, and ACP sessions; session shutdown settles live work before unloading
them. See the [operator configuration
reference](https://github.com/cogitave/namzu/blob/main/docs/cli/reference.md#plugins).

## Headless runs

```bash
namzu run "fix the failing test" --format json
namzu run-stream "refactor the parser" | jq -c 'select(.type == "tool_call")'
```

`run` prints a result; `run-stream` emits one structured event per line as the
run happens, so a script can act on a tool call before the run is over. Both
take `--verbose`/`--quiet`, and both write logs to stderr so stdout stays a
clean protocol stream.

The interactive transcript also shows provider capability mismatches and
tool-history repairs before the affected answer. A history warning reports the
source and measured rewrite counts without echoing tool content, and tells the
operator to verify external state before retrying a non-idempotent interrupted
call.

## Documentation

- [The operator application](https://github.com/cogitave/namzu/blob/main/docs/cli/reference.md) — every command, the configuration surface, headless event shapes
- [`namzu doctor`](https://github.com/cogitave/namzu/blob/main/docs/cli/doctor.md)
- [All docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
