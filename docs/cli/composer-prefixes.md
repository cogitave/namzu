---
type: Reference
title: The composer prefixes
description: What a line starting with `!` or `#` does in the CLI's composer — a command run on the host without the model, or a note remembered — what `@path` attaches (quoted paths, any script, line ranges), and what the model learns of either.
resource: packages/cli/src/tui/shell-escape.ts
tags: [cli, composer, shell, memory]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# The composer prefixes

Two first characters make a line something other than a prompt — in a line
you type, or in a [loop you made](session-loops.md). A loop the model made
is always sent as a prompt, so its `!` and `#` lines never run or remember
anything ([The model's version](session-loops.md#the-models-version)).

## `!command` — the operator's own shell

`!ls -la` runs `ls -la` on the host, in the session's working directory, with the operator's environment and authority. It is not the model's `bash` tool: no model call is made, the authorization gate is not consulted, and the command does not enter the sandbox. The operator typing a command is the operator, not a tool call, and the gate exists to review the model.

What the operator sees: their line, then a row `! ls -la · exit 0` with the output under it. While the command runs the row shows `…`; a non-zero exit or a kill shows `✗`.

What the model sees: on its next turn, a system block naming every `!` command run since its last turn, with the output and the exit. A `!` line that left no trace for the model would be a command the operator then has to describe in prose.

On POSIX hosts the interpreter remains `/bin/sh`; on Windows it uses the native platform command shell (normally CMD). Shell syntax follows that interpreter. The shared host runner decodes split UTF-8 output, refuses a signal already aborted before launch, and retains process-start errors in the transcript.

Bounds: a command that has not ended after 60 seconds is stopped with its owned process tree, and the row says `killed after 60s`. Output is cut at 20,000 characters for the transcript and 8,000 for the model. The host runner also stops a command once either stream exceeds 80,000 bytes, keeping memory bounded; the row marks the truncated output.

## `#note` — remember

`#always run tests with pnpm` saves the note as a typed `project` memory — one Markdown file in this project's stored memory — exactly as `/memory add <text>` does, and the row names the file. The next turn's prompt lists it in the stored-memory index. `/memory --user add <text>` remembers something for every project. See [Memory](memory.md). A `#` with nothing after it is sent as a prompt.

## `@path` — attach a file

`@src/auth.ts` anywhere in a message sends that file's text with it as a `<file>` block; the message you see keeps the readable `@path`. Only regular files resolving inside the working directory are read. Reads use chunks of at most 16 KiB, not a whole-file allocation, and stop at the file size observed when opened even if it grows. Missing, replaced or unreadable paths stay plain text.

File expansion attempts at most 32 distinct file/range mentions per message. Each file contributes at most 60,000 characters; the message has a 240,000-character file-content budget (plus truncation markers and block labels). Scanning stops at 8 MiB per file and 16 MiB across the message, including bytes skipped to reach a line range. Later mentions beyond those budgets stay plain text. These limits do not change the working-directory boundary or grant access outside it.

- **Names.** Letters, digits and combining marks of any script, and `_ - . / \ ( ) [ ] ~ :` may stand bare. A path with anything else, a space included, is written in quotes: `@"my docs/notes v2.md"`. Completion offers the files git lists (tracked and not ignored) and writes the quotes for you when the name needs them.
- **Lines.** `@file.ts#L10-20` sends lines 10 to 20 inclusive and `#L7` sends line 7; the block says `lines="10-20"`. The 60,000-character cap applies to the lines sent. Preceding lines are scanned without retaining them; a range is reachable only within the byte-scan budgets above. If its first line is not reached, the mention stays plain text. A range written backwards sends the whole file.
- **Trailing punctuation.** A sentence's `,` `.` `;` `:` `!` `?`, and a `)` or `]` with no opener in the token, are not part of the name: `(see @a.ts)` mentions `a.ts`.

### Agents and tool-server resources

The same `@` list also offers the sub-agents a session can hand work to and the resources its connected tool servers publish, with a short description beside each.

- **Agents.** `@"reviewer (agent)"` (or `@agent-reviewer`) names a sub-agent: `explore`, `plan` and every agent defined in `.namzu/agents/` or `~/.namzu/agents/`. Nothing is inlined; the message carries a short `<mentioned-agent>` note that tells the model to give the fitting part of the request to that agent. A name that is not a known agent stays a file path.
- **Resources.** `@"docs:docs://guide"` names a resource a connected tool server published (`server:address`). The text is read when the message starts a turn and sent as a block marked with a fresh marker and a line saying it came from the tool server, to be read as information. The server's allow and deny lists apply, only an address the server listed is read, a server set to ask for approval before use is left out of the list, a resource is cut at 60,000 characters, and one that cannot be read is left out without stopping the message. A message sent while a turn is already running leaves the mention as written.

Not available: resource templates (`@server:template/{id}` with completion of its values), a configurable file-suggestion command, and a setting to include ignored files.

## Neither is read for composer triggers

A line whose first character, after any leading spaces, is `/`, `!` or `#` is
a command, so the composer never reads it for [composer
triggers](composer-triggers.md): `!echo hypermode` runs `echo hypermode` and
arms nothing.
