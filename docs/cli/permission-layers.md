---
type: Reference
title: Permission layers and remembered answers
description: How the permissions tables of the user file, the project's files, the project's local file, a selected profile and the managed file combine (a deny from any layer wins), where a "don't ask again" answer is written (`.namzu/settings.local.json`), how the earlier `namzu.config.local.json` moves there, and which shell commands run without a prompt.
resource: packages/cli/src/permissions/rules.ts
tags: [cli, permissions, config, layers]
status: stable
generated: { by: process:claude-code, at: 2026-10-19T00:00:00Z }
---

# Permission layers and remembered answers

The `permissions` table is read from every config file that has one, and the tables are **joined**, not replaced. The order, lowest to highest: user (`~/.namzu/config.yaml`), project (`namzu.config.json`, then `.namzu/settings.json`), local (`namzu.config.local.json` while it is still there, then `.namzu/settings.local.json`), a selected profile, managed.

## How the layers combine

Each layer decides a call on its own, by the rules it always had: the most specific pattern first, and a narrower allow in a table beats a broader deny of the same table. The layers are then combined:

1. if any layer denies the call, it is denied;
2. else if any layer asks, it is asked about;
3. else if any layer allows it, it runs;
4. else no layer named it and the mode decides.

Which layer is higher does not change the outcome. A project table cannot erase a user's deny, and a managed table adds to the rules below it. `permissions` on the loaded config is the combined view (the stricter effect where two layers name the same pattern); `permissionLayers` is the list the decision is made from. `permissionLayers` is the loader's own field: a file that writes it is refused.

The same table also holds five settings that are not tools: `defaultMode`, `disableBypassMode`, `disableAutoMode`, `outsideRoot` and `autoMode`. The loader lifts them out before the rules are compiled, and the file they came from decides which of them stand (a project file cannot make `bypass` or `auto` the default, and cannot set `autoMode`; `outsideRoot: refuse` from any file stands and no file undoes it, so a project can only make it stricter); they are the `permissionSettings` field of the loaded config, which a file cannot write. [Permission modes](permission-modes.md#settings) has the table.

Before this, a layer that wrote a `permissions` table replaced the whole table of every layer below it, key by key.

## The sandbox block

`sandbox` is the operator's, and the layers combine key by key (before, the later file replaced the whole block). The user file and the environment keep full control and merge per key; the managed file keeps full control and replaces the whole block, so a key it does not name is not carried over from a user's file. The project file, the local file and a profile declared in either may only tighten it:

| Key | A repository file may | A repository file may not |
|---|---|---|
| `enabled` | turn it on | turn it off |
| `allowEscape` | set `false` | set `true` over a user `false` |
| `allowUnattendedEscape` | set `false` | set `true` |
| `requireIsolation` | add controls | remove one a lower layer required |
| `workspace` | ask for `ephemeral` (it confines more) | set `working-directory` over a user `ephemeral` |
| `teardownTimeoutMs` | nothing | set it: a short wait can abandon a sandbox still running, and `0` waits forever |

Each value that was ignored and would have changed something is named once at launch, with the key and the file, and says to set it in `~/.namzu/config.yaml`. A repository that repeats what you already chose is not mentioned. The terminal app shows the note at launch and `namzu exec` prints it on stderr. A profile follows the file that declares it, by where the file really is and not by its name: a profile in `~/.namzu/config.yaml` has full control, one in the project or local file does not. The keys are described in [Tool boundary](tool-boundary.md#leaving-the-sandbox-for-one-command).

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

## The project's files

A folder carries two layers of its own, both read only after the folder is trusted:

| Layer | Files, lowest first | Meant for |
|---|---|---|
| project | `namzu.config.json`, `.namzu/settings.json` | the shared settings, checked in |
| local | `namzu.config.local.json` (earlier name), `.namzu/settings.local.json` | this computer's settings for the folder, kept out of git |

The files of one layer take the same settings. Both are read: the rules and hooks of both apply, and where both set any other setting the later file wins (`.namzu/settings.json` over `namzu.config.json`). `namzu doctor` (the *Settings files* row) and `/status` say when both files of a layer are there, so you can keep one. A relative path in a rule of `.namzu/settings.json` or `.namzu/settings.local.json` is read against the project folder, as it is in `namzu.config.json`, not against `.namzu`.

## The local file

`.namzu/settings.local.json` is read as the layer over the project files and is where a "don't ask again" answer and `/permissions add` are written. It is read only where the project files are (after the folder is trusted) and under the same limits (`decision`, `model` and `routing` are ignored; `browser.defaultProfile` is refused). A write to it by the model is a protected-path question like a write to `namzu.config.json`, since everything under `.namzu` is protected.

Every write goes through one writer: it holds `.namzu/settings.local.json.lock` (a lock left by a process that is gone, or older than ten seconds, is taken over), re-reads the file, applies the change, writes `.namzu/settings.local.json.<pid>.<random>.tmp` with mode 0600, flushes it to disk, renames it over the file, and reads the result back. A `.namzu` that is a link or a file, or a settings file that is a link, is refused, and the answer holds for the session only.

### Moving the earlier file

Before this, the file was `namzu.config.local.json` at the top of the folder. At the start of a session in a trusted folder, and before the first write, Namzu moves it:

- Only the old file: its bytes are written to `.namzu/settings.local.json`, read back and compared, and the old file is checked unchanged; only then is it removed. The answers in it keep deciding, now from the new place.
- Both files, holding the same settings: the old one is removed. (Until then it is not read a second time.)
- Both files, holding different settings: nothing moves. Both are read, the new one over the old, and the start of the session says so in one sentence. Move what you keep into `.namzu/settings.local.json` and delete the old file.
- An old file git tracks, one that is not valid JSON, a link, or a git that cannot say: nothing moves, the old file is still read, and the start of the session says why. New answers go to `.namzu/settings.local.json`.
- A folder that is not trusted: nothing is read, moved or written.

`/permissions remove` takes a rule out of both files while the old one is still read. A staging file an earlier writer left (`namzu.config.local.json.<pid>.tmp` or `.namzu/settings.local.json.<pid>.<random>.tmp`) is removed at session start when its process is gone, it is over an hour old and the settings file it was meant for reads as JSON; such a file was never a saved answer. `namzu state` names the old file while it is there.

## Edit rules during a conversation

`/permissions rules [allow|ask|deny]` lists rules with their settings file. Use
`/permissions add <allow|ask|deny> <rule>` and `/permissions remove <rule>` to
edit `.namzu/settings.local.json` (a remove also edits `namzu.config.local.json`
while that one is still read). Like an answer, an added rule that looks like it
holds a password or a token is refused, and so is a save into a local file git
tracks. Both add and remove then make sure git ignores the file, as below.
Successful edits update subsequent authorization
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

A prompt for a plain shell command, a fetch or an MCP tool offers `Yes, and don't ask again for <what> in <folder>`. The answer approves the call, holds for the rest of the session at once, and is written to the folder's `.namzu/settings.local.json` as `permissions.<tool>.<pattern> = "allow"`, so the next session starts with it. A line that adds only a read-only filter or a harmless redirection to one command (`npm test 2>&1 | tail -20`) is offered as that command (`npm test *`), and the saved rule covers the same line later: every other command of the line must only read (`tail`, `head`, `grep`, `wc`), and a line that writes a file through a redirection, pipes into a shell or runs another program is asked about as before. The write merges into what the file already says; a file that is not valid JSON is left alone, and the session is told the answer holds for this session only.

It is held for this conversation only, and the answer says so in one sentence, when:

- the folder is not trusted (its local file is not read there);
- git tracks `.namzu/settings.local.json`, so a saved answer would become a change in a committed file (asked once per folder and session, with a two-second limit; no git, or no answer from git, counts as not tracked);
- the rule looks like it holds a password or a token: the credential shapes Namzu redacts from its logs (vendor keys, bearer headers, JWTs) and the places a command line carries one (`-u user:pass`, `mysql -p<password>`, `sshpass -p`, `--password`/`--token`/`--api-key` and similar flags, `password=` and `token:` values, an `Authorization:` header, `user:pass@` in an address). A compound answer saves its other rules.

After a write, in a git work tree, Namzu adds `**/.namzu/settings.local.json*` to the global git ignore file (`core.excludesFile`, else `$XDG_CONFIG_HOME/git/ignore`, else `~/.config/git/ignore`), unless git already ignores the file; the star covers the lock and staging files. It does the same after `/permissions add` and `remove`, and at the start of a session in a trusted folder that has a local file, so a file made some other way is covered too. A `**/namzu.config.local.json` line written by an earlier Namzu stays. A file git already tracks cannot be ignored and is logged.

What the answer remembers:

- **A two-word prefix** (`git commit *`, `npm run *`) when the command has at least two words, the first is not a shell or a wrapper (`sh`, `bash`, `zsh`, `env`, `xargs`, `sudo`, `doas`, `su`, `timeout`, `nohup`, `nice`, `time`, `watch`, `command`, `builtin` and the rest of the list) and the second is a plain lower-case subcommand (`commit`, `cherry-pick`). `*` after a space matches the bare command too and is a word boundary, so `git commit *` does not cover `git commitx`.
- **The exact command** otherwise (`make`, `git -C sub status`, `cd src`).
- **One rule per command** for a compound line (`a && b | c`), up to five; the line must be made of plain commands, so one with a glob, a substitution, a redirection or several lines gets no such answer.
- **The host** of a fetched URL (`http://host/*` and `https://host/*`) and **one MCP tool** by name.

An answer never covers a call that is asked every time: a sandbox escape, a path outside the roots, a protected path, a catastrophic removal, a rule's `ask`, a destructive call. A `deny` in any layer still beats it.

## Shell commands that run without a prompt

`ls`, `cat`, `git status`, `git diff` and the other commands on the read-only list run without a prompt in `prompt` and `accept-edits`, and in `plan`. The list, the conditions and what is not ported are in [The bash tool](../sdk/bash-tool.md#read-only-lines). The path floor still applies: a read-only command that reads outside the working directory and added directories is asked about.

## Allow rules that allow any program

An allow rule can be wider than it reads. `Bash(python *)` lets Python run any code it is given, so it allows whatever a model can write in a line of Python. The same goes for a bare `Bash` or `Bash(*)`, an interpreter (`python`, `node`, `deno`, `tsx`, `ruby`, `perl`, `php`, `lua`), a launcher (`npx`, `bunx`, `npm run`, `yarn run`, `pnpm run`, `bun run`), `eval`, `exec`, `ssh`, a shell (`bash -c *`, `sh`, `zsh`, `cmd`, `pwsh`), a wrapper that runs the command after it (`env`, `xargs`, `sudo`, `timeout`, `nohup`) and the network tools `curl`, `wget`, `kubectl`, `aws`, `gcloud` and `gsutil` when the rule names no address or subcommand. With or without `:*`, a trailing ` *` or `*`.

Such a rule keeps doing what it says. Nothing about matching changes. Namzu tells you about it, with the rule, the file it is in and a narrower rule to write instead (`Bash(python scripts/build.py *)`, `Bash(npm run build)`, `Bash(curl https://api.example.com/*)`, `Bash(kubectl get *)`):

- `namzu doctor` and `/doctor` have a `runtime.permission-allow-rules` row that warns.
- Once at the start of a conversation, `namzu exec` and `namzu drain`, a warning in the log names each one.

A rule that names a script, a package, a host or a read-only subcommand is left alone, and so are `ask` and `deny` rules. `classify` mode already sends a call under such a rule to its reviewer. A "don't ask again" answer never offers one of these.

## Edits in place under accept-edits

`accept-edits` runs `sed` in place without asking only in one form: `sed -i [-E|-r|--posix] 's/old/new/[flags]' file...`, on literal paths inside the working folders. The script is one `s` with `/` as its delimiter and flags from `g p i m I M` and one digit. A backup suffix on `-i` (`-i.bak`, `--in-place=.bak`), `-e`, `-n`, a second script or `;`, another delimiter, a line command such as `3d`, an address, a `\`, a `[`, `..`, an `e` or `w` flag, a glob or a variable in a path, a path outside the folders, a protected path, a pipe to another program or a redirect outside the folders are asked about, as before. `sed` without `-i` (a read) and the other file commands (`mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`) are as they were. The dangerous-command floor and the protected paths are unchanged.

## A command line that sends as the person

One refusal is built in and cannot be turned off, loosened or overridden: a command line a model starts may not run `namzu send`. `namzu send` puts words in front of another session's model as the person's, so a session's agent (or a sub-agent, or a poisoned tool result steering one) must not be able to run it. The rule is a deny-only predicate placed first in every session's gate (`packages/cli/src/permissions/send-floor.ts`, wired in `cliGate`), so it holds in every permission mode, `bypass` and `auto` included, and a deny from any layer wins, so no allow rule, remembered answer or hook reopens it. The call does not run; the model is told, in plain words, that a message to another session must come from a person at their own terminal and that rewording will not help.

It reads the line with the SDK's shell reader ([How command lines are read](../sdk/command-lines.md)) in both dialects, so these all refuse, and the same words are refused when the line is a `sh -c` or `bash -c` payload, a `$(…)` body, a subshell or a background command:

- `namzu send …`, a path to it, `namzu.cmd`, and quoted or escaped spellings of the subcommand (`namzu 'se'nd`, `namzu $'\x73end'`);
- the CLI's entry script through a runtime: `node packages/cli/dist/bin.js send …` (`bin`, `bin.js`, `bin.mjs`, `bin.cjs`), and the package by name: `npx @namzu/cli@latest send …`, `pnpm dlx @namzu/cli send …`;
- behind a wrapper: `env`, `env -i`, `setsid` and `setsid -f`, `nohup`, `timeout`, `nice`, `sudo`, `xargs`, `find -exec`, `command`; the whole command is scanned, not only its head;
- a program name that expands (`$(command -v namzu) send …`, `$A $B …`) followed by a literal `send` or by another expanding word, and a subcommand that expands (`namzu $SUB …`);
- a line the reader cannot account for (an opaque construct, `eval`, a shell reading a script or standard input, an interpreter given the text, `xargs`) whose text holds the CLI and then `send`.

It does not refuse `namzu peers send` (the agent-to-agent channel, which says what it is on the receiving side), other `namzu` subcommands, or a command that only prints or searches for the words (`echo`, `printf`, `grep`, `rg`, `cat`, `git`, `ls` …).

**What the reader cannot see through**, said exactly: a script or program whose contents the line only runs (`sh ./run.sh` when the file says `namzu send`); a name assembled from pieces that never stand together in the line (`eval "n=nam; ${n}zu se''nd"`); a copy or a link of the CLI under another name (`ln -s "$(command -v namzu)" ./x && ./x send …`); text a program builds and runs by itself; and any tool whose argument is not a command line (the rule reads the command argument of tools that declare one). The kernel's other two layers cover those: the environment marker `NAMZU_STARTED_BY_SESSION` that `namzu send` refuses on, and process ancestry. What is left after all three is written on [Watching a session](watching-a-session.md#not-from-a-tool-or-an-agent).

## Upgrading

If a repository file loosened the sandbox (`enabled: false`, `allowUnattendedEscape: true`), that no longer applies: put the setting in your own config file or the managed file.

If you relied on a project or managed table replacing a user's rules, move the rule you wanted gone out of the lower file; there is no way for a higher layer to switch a lower layer's deny off, by design. A rule that used to be hidden by a higher layer's table now applies again, which can ask about or refuse calls that used to run.
