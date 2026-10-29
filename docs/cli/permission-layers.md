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

The `permissions` table is read from every config file that has one, and the tables are **joined**, not replaced. The order, lowest to highest: user (`~/.namzu/config.yaml`), project (`namzu.config.json`), local (`namzu.config.local.json`), a selected profile, managed.

## How the layers combine

Each layer decides a call on its own, by the rules it always had: the most specific pattern first, and a narrower allow in a table beats a broader deny of the same table. The layers are then combined:

1. if any layer denies the call, it is denied;
2. else if any layer asks, it is asked about;
3. else if any layer allows it, it runs;
4. else no layer named it and the mode decides.

Which layer is higher does not change the outcome. A project table cannot erase a user's deny, and a managed table adds to the rules below it. `permissions` on the loaded config is the combined view (the stricter effect where two layers name the same pattern); `permissionLayers` is the list the decision is made from. `permissionLayers` is the loader's own field: a file that writes it is refused.

The same table also holds four settings that are not tools: `defaultMode`, `disableBypassMode`, `disableAutoMode` and `autoMode`. The loader lifts them out before the rules are compiled, and the file they came from decides which of them stand (a project file cannot make `bypass` or `auto` the default, and cannot set `autoMode`); they are the `permissionSettings` field of the loaded config, which a file cannot write. [Permission modes](permission-modes.md#settings) has the table.

Before this, a layer that wrote a `permissions` table replaced the whole table of every layer below it, key by key.

## Rules as lists

Besides the per-tool table, `permissions` accepts three lists, `allow`, `ask` and `deny`, whose entries are a tool name or a tool name with a specifier in parentheses. The lists are folded into the table when the file is read, so they join across layers exactly as the table does and the two can be mixed in one file.

```yaml
permissions:
  allow: ["Bash(git status:*)", "Read"]
  ask: ["Bash(git push *)"]
  deny: ["Bash(rm -rf *)", "Read(./.env)", "WebFetch(domain:example.com)", "mcp__files__delete"]
```

- `Tool`, `Tool()` and `Tool(*)` cover every call to the tool.
- A trailing `:*` means the same as a trailing space and star: `git push:*` is `git push *`, and it also matches the bare `git push`.
- A literal parenthesis in a specifier is written `\(` and `\)`.
- Names are the tools' own, with capitalised words accepted: `Bash` is `bash`, `WebFetch` is `web_fetch`. Tool-server names such as `mcp__files__delete` are used as written.
- `WebFetch(domain:host)` matches addresses on exactly that host.
- A file tool's specifier is a path; see [File rules are paths](#file-rules-are-paths).
- When two entries disagree about the same tool or pattern, the stricter one stands (deny, then ask, then allow). Adding a whole-tool list entry keeps an existing per-pattern table: `allow: ["Read"]` does not erase `read: { ".env": "deny" }`, regardless of key order.
- An entry that is not a rule stops the file loading, and the message names the list and the position.

## File rules are paths

A pattern under `read`, `edit`, `write`, `grep`, `glob` or `ls` names a file, not text inside the call. Patterns are resolved relative to the settings file that supplied that layer (including a profile in that file). Call paths are resolved separately against the execution working directory. In settings stored in `/work/app`, `.env` and `./.env` name `/work/app/.env`; a call can name that file absolutely or relative to its own working directory. Moving the execution working directory does not move the policy.

| Pattern starts with | Relative to |
|---|---|
| `//` | the filesystem root (`//etc/hosts` is `/etc/hosts`) |
| `~/` | your home folder |
| `/` | the folder containing the settings file |
| `./` or a name | the folder containing the settings file |

`*` stays inside one folder, `**` crosses folders, and dot files need no special spelling. A rule on a folder covers everything inside it. A trailing `/**` names that folder itself too: `src/public/**` covers a search rooted at `src/public`, with or without a trailing slash, as well as files below it. A link is followed: a `deny` or `ask` also applies to the file a link leads to, and an `allow` holds only if the link's target is inside the allowed path too.

```yaml
permissions:
  deny: ["Read(./.env)", "Edit(~/.ssh/**)", "Edit(//etc/**)"]
  allow: ["Edit(src/**)"]
```

A rule on `read` also decides `grep`, `glob` and `ls`, and a rule on `edit` also decides `write`, so a refused file cannot be reached with the sibling tool. An omitted search path means the execution working directory, as it does in the tool. A bare `*` still means every call to the tool.

Search and listing tools authorize a root, not each returned entry. A search rooted above a denied descendant is therefore **refused as a whole**, even if a whole-tool allow covers the search tool. An `ask` descendant instead sends that search for review. This boundary is conservative: it does not use `include`, the glob expression, hidden-file flags or listing depth to prove a search safe. A parent search mixing permitted and denied paths loses its permitted results too; there is no per-result filtering yet. Narrow the root to a safe sibling subtree, or read a permitted file directly. A rule that directly names a subtree still uses the ordinary specificity rules, including narrower same-layer allowances.

This check uses path/glob overlap rather than enumerating the disk, so a currently absent restricted descendant is not silently exempt. Existing logical and physical spellings of the search root are checked; this is not an atomic filesystem confinement guarantee against concurrent symlink changes.

Before this, the pattern was matched against the call's serialised input, so `*.ts` matched a `.ts` file in any folder and `*/.env` matched `.env` anywhere. Now `*.ts` means the `.ts` files directly in the settings folder; write `**/*.ts` for any folder.

## The local file

`namzu.config.local.json` sits beside `namzu.config.json`. It takes the same settings, is read as the layer over the project file, and is where a "don't ask again" answer is written. It is read only where the project file is (after the folder is trusted) and under the same limits (`decision`, `model` and `routing` are ignored; `browser.defaultProfile` is refused). A write to it by the model is a protected-path question like a write to `namzu.config.json`.

## Edit rules during a conversation

`/permissions rules [allow|ask|deny]` lists rules with their settings file. Use
`/permissions add <allow|ask|deny> <rule>` and `/permissions remove <rule>` to
edit `namzu.config.local.json`. Successful edits update subsequent authorization
decisions in the current terminal session, including gates already held by a
running turn. You do not need to restart to remove an existing local rule.
The screen confirms whether the saved edit was applied; a failed save does not
change the active policy, and a failed reload keeps the previous policy active.

Only the direct local rules table is replaced. User, project, managed and
selected-profile rules, run restrictions, browser site policy and sandbox
boundaries remain in force. Removing a local deny does not remove a deny from
another layer. An edit does not replay an earlier refused call or automatically
answer a permission dialog that is already open; it governs later gate decisions.
A successful reload also clears cached remembered answers: the saved local table
now decides them, so a removed allow cannot linger in memory. An answer that was
held only in memory because its save failed may therefore ask again.
External settings-file edits are not watched by this editor. Other configuration
settings and non-local rule edits still require a new session.

## "Don't ask again"

A prompt for a plain shell command, a fetch or an MCP tool offers `Yes, and don't ask again for <what> in <folder>`. The answer approves the call, holds for the rest of the session at once, and is written to the folder's `namzu.config.local.json` as `permissions.<tool>.<pattern> = "allow"`, so the next session starts with it. The write merges into what the file already says; a file that is not valid JSON is left alone, and the session is told the answer holds for this session only.

The first time it writes, in a git work tree, Namzu adds `**/namzu.config.local.json` to the global git ignore file (`core.excludesFile`, else `$XDG_CONFIG_HOME/git/ignore`, else `~/.config/git/ignore`), unless git already ignores the file. A file git already tracks cannot be ignored and is logged.

What the answer remembers:

- **A two-word prefix** (`git commit *`, `npm run *`) when the command has at least two words, the first is not a shell or a wrapper (`sh`, `bash`, `zsh`, `env`, `xargs`, `sudo`, `doas`, `su`, `timeout`, `nohup`, `nice`, `time`, `watch`, `command`, `builtin` and the rest of the list) and the second is a plain lower-case subcommand (`commit`, `cherry-pick`). `*` after a space matches the bare command too and is a word boundary, so `git commit *` does not cover `git commitx`.
- **The exact command** otherwise (`make`, `git -C sub status`, `cd src`).
- **One rule per command** for a compound line (`a && b | c`), up to five; the line must be made of plain commands, so one with a glob, a substitution, a redirection or several lines gets no such answer.
- **The host** of a fetched URL (`http://host/*` and `https://host/*`) and **one MCP tool** by name.

An answer never covers a call that is asked every time: a sandbox escape, a path outside the roots, a protected path, a catastrophic removal, a rule's `ask`, a destructive call. A `deny` in any layer still beats it.

## Shell commands that run without a prompt

`ls`, `cat`, `git status`, `git diff` and the other commands on the read-only list run without a prompt in `prompt` and `accept-edits`, and in `plan`. The list, the conditions and what is not ported are in [The bash tool](../sdk/bash-tool.md#read-only-lines). The path floor still applies: a read-only command that reads outside the working directory and added directories is asked about.

## Upgrading

If you relied on a project or managed table replacing a user's rules, move the rule you wanted gone out of the lower file; there is no way for a higher layer to switch a lower layer's deny off, by design. A rule that used to be hidden by a higher layer's table now applies again, which can ask about or refuse calls that used to run.
