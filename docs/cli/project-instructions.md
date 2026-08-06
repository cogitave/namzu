---
title: Project instructions
description: namzu reads the AGENTS.md files from the working directory up to the repository root and follows them as standing policy for work in that project.
last_updated: 2026-08-06
status: current
related_packages: ["@namzu/cli"]
---

# Project instructions

A project can tell namzu how it wants work done by committing an `AGENTS.md`. namzu reads it at the start of every session and follows it as standing policy for work in that project.

This is separate from [memory](./memory.md). Memory is about **you** and lives under your home directory; it travels with you between projects. `AGENTS.md` is about **the project** and lives in the repository; it applies to everyone who works there, including a teammate's namzu and namzu's own sub-agents.

```markdown
# AGENTS.md

## Build

`pnpm test` must pass before anything is committed.

## Style

No default exports. Tabs, not spaces.
```

## Where namzu looks

From the working directory **upward**, stopping at the repository root — the first directory that contains a `.git` (a directory in an ordinary clone, a file in a worktree or submodule). If there is no repository, the walk goes to the filesystem root.

Every `AGENTS.md` on that path is loaded. They are ordered outermost first, so a file nearer the working directory comes last and wins where two of them disagree — which is what a per-package instructions file is for.

```
repo/AGENTS.md            ← loaded first (repository-wide)
repo/packages/api/AGENTS.md   ← loaded second, overrides the above
```

The repository boundary is deliberate: without it, a checkout that happens to sit under a directory with its own `AGENTS.md` would silently inherit rules from outside the project.

## How you can tell it was read

namzu names the files it loaded, so "namzu read my conventions and disagreed" is never confused with "namzu never saw them".

- **In the TUI** — a line under the connect banner: `Project instructions: ../AGENTS.md, AGENTS.md`.
- **In `namzu run`** — the same line on stderr, alongside the provider line, so a piped answer is unaffected:

  ```bash
  $ namzu run "add a test for the parser"
  namzu · <provider> · <model>
  project instructions: AGENTS.md
  ```

`namzu run-stream` loads the files identically but does not yet announce them on its event stream.

## Limits

- One file name: `AGENTS.md`.
- A file is read up to 32,000 characters. If it is longer, the rest is not included and the agent is told so explicitly, in place, along with how many characters were dropped — a truncated policy is never presented as a whole one.
- An empty or whitespace-only file is skipped.
- The files are read once, when the session opens. That is what makes the list namzu prints exactly the set that went into the prompt. Edit a file and restart namzu (or run a new one-shot) for the change to take effect.

## What they can and cannot do

The block is injected as system context, after namzu's own identity and rules, and is labelled as the project speaking rather than as a request from you. Instructions are followed for work in the repository; they do not change what namzu is and do not relax any rule above them.

This matters because the file is read off whatever directory namzu was pointed at, including with `namzu run --cwd ../someone-elses-checkout`. Treat an `AGENTS.md` from a repository you do not trust the way you would treat its build script — which namzu will also run.
