---
type: Reference
title: Permission layers and remembered answers
description: How the permissions tables of the user file, the project file, the project's local file, a selected profile and the managed file combine (a deny from any layer wins), where a "don't ask again" answer is written, and which shell commands run without a prompt.
resource: packages/cli/src/permissions/rules.ts
tags: [cli, permissions, config, layers]
status: stable
generated: { by: process:claude-code, at: 2026-10-19T00:00:00Z }
---

# Permission layers and remembered answers

The `permissions` table is read from every config file that has one, and the tables are **joined**, not replaced. The order is the reference terminal's, lowest to highest: user (`~/.namzu/config.yaml`), project (`namzu.config.json`), local (`namzu.config.local.json`), a selected profile, managed.

## How the layers combine

Each layer decides a call on its own, by the rules it always had: the most specific pattern first, and a narrower allow in a table beats a broader deny of the same table. The layers are then combined:

1. if any layer denies the call, it is denied;
2. else if any layer asks, it is asked about;
3. else if any layer allows it, it runs;
4. else no layer named it and the mode decides.

Which layer is higher does not change the outcome. A project table cannot erase a user's deny, and a managed table adds to the rules below it. `permissions` on the loaded config is the combined view (the stricter effect where two layers name the same pattern); `permissionLayers` is the list the decision is made from. `permissionLayers` is the loader's own field: a file that writes it is refused.

The same table also holds four settings that are not tools: `defaultMode`, `disableBypassMode`, `disableAutoMode` and `autoMode`. The loader lifts them out before the rules are compiled, and the file they came from decides which of them stand (a project file cannot make `bypass` or `auto` the default, and cannot set `autoMode`); they are the `permissionSettings` field of the loaded config, which a file cannot write. [Permission modes](permission-modes.md#settings) has the table.

Before this, a layer that wrote a `permissions` table replaced the whole table of every layer below it, key by key.

## The local file

`namzu.config.local.json` sits beside `namzu.config.json`. It takes the same settings, is read as the layer over the project file, and is where a "don't ask again" answer is written. It is read only where the project file is (after the folder is trusted) and under the same limits (`decision`, `model` and `routing` are ignored; `browser.defaultProfile` is refused). A write to it by the model is a protected-path question like a write to `namzu.config.json`.

## "Don't ask again"

A prompt for a plain shell command, a fetch or an MCP tool offers `Yes, and don't ask again for <what> in <folder>`. The answer approves the call, holds for the rest of the session at once, and is written to the folder's `namzu.config.local.json` as `permissions.<tool>.<pattern> = "allow"`, so the next session starts with it. The write merges into what the file already says; a file that is not valid JSON is left alone, and the session is told the answer holds for this session only.

The first time it writes, in a git work tree, Namzu adds `**/namzu.config.local.json` to the global git ignore file (`core.excludesFile`, else `$XDG_CONFIG_HOME/git/ignore`, else `~/.config/git/ignore`), as the reference does for its own local file, unless git already ignores the file. A file git already tracks cannot be ignored and is logged.

What the answer remembers, as the reference suggests it:

- **A two-word prefix** (`git commit *`, `npm run *`) when the command has at least two words, the first is not a shell or a wrapper (`sh`, `bash`, `zsh`, `env`, `xargs`, `sudo`, `doas`, `su`, `timeout`, `nohup`, `nice`, `time`, `watch`, `command`, `builtin` and the rest of the reference's list) and the second is a plain lower-case subcommand (`commit`, `cherry-pick`). `*` after a space matches the bare command too and is a word boundary, so `git commit *` does not cover `git commitx`.
- **The exact command** otherwise (`make`, `git -C sub status`, `cd src`).
- **One rule per command** for a compound line (`a && b | c`), up to five; the line must be made of plain commands, so one with a glob, a substitution, a redirection or several lines gets no such answer.
- **The host** of a fetched URL (`http://host/*` and `https://host/*`) and **one MCP tool** by name.

An answer never covers a call that is asked every time: a sandbox escape, a path outside the roots, a protected path, a catastrophic removal, a rule's `ask`, a destructive call. A `deny` in any layer still beats it.

## Shell commands that run without a prompt

`ls`, `cat`, `git status`, `git diff` and the other commands on the reference's read-only list run without a prompt in `prompt` and `accept-edits`, and in `plan`. The list, the conditions and what is not ported are in [The bash tool](../sdk/bash-tool.md#read-only-lines). The path floor still applies: a read-only command that reads outside the working directory and added directories is asked about.

## Upgrading

If you relied on a project or managed table replacing a user's rules, move the rule you wanted gone out of the lower file; there is no way for a higher layer to switch a lower layer's deny off, by design. A rule that used to be hidden by a higher layer's table now applies again, which can ask about or refuse calls that used to run.
