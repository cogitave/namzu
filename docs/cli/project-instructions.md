---
type: Reference
title: Project instructions
description: Which files make up the instructions a session is given (your own file, each directory's AGENTS.md, rule files, the private AGENTS.local.md), the order they apply in, @path includes, conditional rules, and what is refused.
resource: packages/cli/src/context/instruction-scope.ts
tags: [cli, instructions, context, agents-md]
status: stable
generated: { by: process:agent, at: 2026-10-27T00:00:00Z }
---

# Project instructions

A session is told how a project wants work done by plain Markdown files. `AGENTS.md` is the only file name; there is no second spelling to keep in sync.

## What is read, and the order

Later text wins where two files disagree, so the order is the override rule. A session reads:

1. **Your own instructions**, from the Namzu home (`~/.namzu`, or `NAMZU_HOME`): `AGENTS.md`, then every `*.md` under `rules/`. They apply to every project and come first, so a project can always say something more specific.
2. **Each directory from the repository root down to the working folder**, outermost first, the folder you are working in last. Each directory contributes, in this order:
   - its `AGENTS.md`;
   - every `*.md` under its `.namzu/rules/` (sub-folders included), sorted by path;
   - its `AGENTS.local.md`, for notes that are yours alone. Keep it out of version control with a `.gitignore` line (`AGENTS.local.md`); Namzu never writes to your `.gitignore`.

The search stops at the repository root (the first directory holding a `.git`). With no repository above the working folder, only that folder is read. Instructions in a folder below the working directory are picked up when a file there is read, written or edited.

`/context` lists these files under Memory files, and `/init` names the ones that exist before it proposes edits.

## Including another file

A line may pull in a file by naming it as `@path`, relative to the file that names it, or starting with `~/` or `/`. The included file follows the one that named it, in its own section.

- Five levels deep at most, counted from the file that started them.
- A file is taken once, however many ways it is reached, which also ends a loop.
- Mentions inside a code block or between backticks are text, not includes. A name that is not a file (`@someone`) is left alone.
- Only text files are followed: `.md`, `.markdown`, `.mdx`, `.txt`, `.text`, `.json`, `.yaml`, `.yml`, `.toml`.
- A project file may include only from inside the repository. Your own file may include from the Namzu home and your home folder. A path that leaves those folders is refused and reported, never read.

HTML comments (`<!-- ... -->`) outside code are dropped from every instruction file before it is sent; a comment inside a code block stays.

## Rules that apply to some files

A rule file may start with front matter listing `paths`:

```md
---
paths:
  - "src/**/*.ts"
---
Use named exports.
```

Such a rule is left out until the session reads, writes or edits a file matching one of the patterns (relative to the directory that holds the rule). `**` in a pattern matches any depth, `*` stays within one folder, `?` is one character and `{a,b}` offers alternatives. `paths: "**"`, or no front matter, means the rule always applies. The front matter itself is never sent.

## What is refused

A file that is skipped is reported, not silently absent: a link that leaves the project, a file over 4 MiB, a path that cannot be read, a rules folder with more than 200 files. Each file is cut at 32,000 characters and the cut is stated where it falls. All instruction text together is limited to 256,000 characters and 256 directories; a directory that would go over is skipped and reported.

Instruction text is sent as standing policy for the project, labelled as such, and never outranks the safety and permission rules.
