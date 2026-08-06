---
title: Project instructions
description: namzu reads the AGENTS.md files from the working directory up to the repository root and follows them as standing policy for work in that project.
last_updated: 2026-08-06
status: current
related_packages: ["@namzu/cli"]
---

# Project instructions

A project can tell namzu how it wants work done by committing an `AGENTS.md`. namzu reads it at the start of every session and follows it as standing policy for work in that project.

> namzu also tells the agent, on every turn, what today's date is and whether the working directory is a git repository and on which branch — see [What namzu already knows](#what-namzu-already-knows) below.

This is separate from [memory](./memory.md). Memory is about **you** and lives under your home directory; it travels with you between projects. `AGENTS.md` is about **the project** and lives in the repository; it applies to everyone who works there, including a teammate's namzu and namzu's own sub-agents.

```markdown
# AGENTS.md

## Build

`pnpm test` must pass before anything is committed.

## Style

No default exports. Tabs, not spaces.
```

## Where namzu looks

From the working directory **upward**, stopping at the repository root — the first directory that contains a `.git` (a directory in an ordinary clone, a file in a worktree or submodule).

Every `AGENTS.md` on that path is loaded. They are ordered outermost first, so a file nearer the working directory comes last and wins where two of them disagree — which is what a per-package instructions file is for.

```
repo/AGENTS.md                ← loaded first (repository-wide)
repo/packages/api/AGENTS.md   ← loaded second, overrides the above
```

The repository boundary is deliberate: without it, a checkout that happens to sit under a directory with its own `AGENTS.md` would silently inherit rules from outside the project.

**If there is no repository above the directory, namzu reads that directory only** and does not walk. The walk would otherwise reach the drive root — a run in a temporary directory would pick up `%TEMP%\AGENTS.md`, and a temporary directory is writable by anything on the machine.

## What namzu refuses to load

A refused file is always named, with the reason, next to the list of the ones that loaded. An empty list cannot tell "this project declares none" apart from "yours was refused", and those want opposite responses.

| Case | What happens |
| --- | --- |
| A symlink whose target is outside the project | Refused and named. A link pointing at, say, a credentials file would otherwise be read into the system prompt. |
| A symlink whose target is inside the project | Followed. Pointing one package's file at another's is an ordinary layout. |
| Larger than 4 MB | Refused and named, without being read. |
| Unreadable for any reason other than being absent | Refused and named, rather than reported as "no file here". |
| A directory named `AGENTS.md` | Ignored. |

## How you can tell it was read

namzu names the files it loaded, so "namzu read my conventions and disagreed" is never confused with "namzu never saw them".

- **In the TUI** — a line under the connect banner: `Project instructions: ../AGENTS.md, AGENTS.md`, plus one line per refused file.
- **In `namzu run`** — the same line on stderr, alongside the provider line, so a piped answer is unaffected:

  ```bash
  $ namzu run "add a test for the parser"
  namzu · <provider> · <model>
  project instructions: AGENTS.md
  ```

`namzu run-stream` loads the files identically but does not yet announce them on its event stream.

## Limits

- One file name: `AGENTS.md`. On a case-insensitive filesystem the OS will also answer to `agents.md`; that is the platform's behaviour, not a promise namzu makes, so a file that has to load everywhere is spelled exactly `AGENTS.md`.
- A file is read up to 32,000 characters. If it is longer, the rest is not included and the agent is told so explicitly, in place, along with how many characters were dropped — a truncated policy is never presented as a whole one.
- An empty or whitespace-only file is skipped.
- The files are read once, when the session opens. That is what makes the list namzu prints exactly the set that went into the prompt, and it keeps the prompt cache from being re-keyed on every file you save. Edit a file and restart namzu (or run a new one-shot) for the change to take effect.

## What namzu already knows

You do not need to write these into `AGENTS.md`; namzu tells the agent itself, freshly on every turn:

- **Today's date**, as the local calendar date on your machine. Without it a model answers from its training cut-off, and writes that year into a changelog entry or a `last_updated` field without anything looking wrong.
- **Whether the working directory is a git repository**, and if so the branch that is checked out — or that HEAD is detached, in which case a commit made there is not reachable from any branch.

Sub-agents are told the same, resolved when the sub-agent is built rather than when the session started.

Deliberately not included: anything about uncommitted changes. That block is the cached prefix of every request and a dirty-file count changes whenever the agent saves a file, so carrying it would re-key the cache on nearly every turn to say what `git status` answers on demand.

## What they can and cannot do

The block is injected as system context, after namzu's own identity and rules, and is labelled as the project speaking rather than as a request from you. Instructions are followed for work in the repository; they do not change what namzu is and do not relax any rule above them.

That framing is a mitigation, not a control — it is a sentence, and a sentence is not a sandbox. The control is which directory you point namzu at.

This matters because the file is read off whatever directory namzu was given, including with `namzu run --cwd ../someone-elses-checkout`. That is why the folder has to be trusted first — in the TUI by the trust prompt, and headlessly by [the same gate](./headless.md#the-folder-has-to-be-trusted). Reading a repository's `AGENTS.md` and running its build are the same decision, and namzu now asks it once, for both.
