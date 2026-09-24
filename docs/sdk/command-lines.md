---
type: Reference
title: How command lines are read
description: The one bash lexer behind argument_pattern rules on a command line, skill Bash(<pattern>) grants and the redirection check, what it reports, and when it calls a line opaque.
resource: packages/sdk/src/authorization/shell-lexer.ts
tags: [sdk, permissions, authorization, bash]
status: stable
generated: { by: process:claude-code, at: 2026-09-23T00:00:00Z }
---

# How command lines are read

A permission rule about a command line is a rule about the commands the line runs, not about its text. `git status && rm -rf ~` is two commands, and an allow rule for `^git status` must not approve the second. `'git' push` is `git push`, and a deny rule for `^git push` must see it. Every decision the SDK makes about a command line goes through one reader, `lexShellCommandLine` in `packages/sdk/src/authorization/shell-lexer.ts`:

- an `argument_pattern` rule on a tool's command argument (`evaluateRule`, `packages/sdk/src/authorization/rules.ts`, through `decomposeCommandLine` and `decodedCommands` in `command-line.ts`);
- a skill's `Bash(<pattern>)` grant ([Skills and allowed-tools](skills.md#syntax)), which is matched the way an allow rule is;
- the check that a skill pattern never covers a line that writes to a file (`writesThroughRedirection`).

`lexShellCommandLine`, `nestedShellCommand`, `NESTED_SHELLS` and their types (`ShellLexResult`, `ShellCommand`, `ShellWord`, `ShellRedirection`, `ShellLexOptions`, `NestedShellCommand`) are exported from `@namzu/sdk`, so a host that decides about a command line in code — a [`predicate` rule](#deciding-in-code) — reads it exactly as the gate does.

Before this reader there were three hand-written walkers, one per purpose, each with its own copy of bash's quoting rules. Each rule of bash's had to be added to all of them, and each place one was missed was a line whose commands the rules did not see.

# What it reads

The lexer reads a line in one of two dialects, the one of the shell that will run it (`ShellDialect`, `lexShellCommandLine(line, { dialect })`). The `bash` tool runs bash wherever the host has it and reports which dialect applies ([The bash tool](bash-tool.md)).

- **`bash`** follows bash 5, in its default mode and in POSIX mode. Where the two modes read a line differently (`time -p cmd` is the command `time` in POSIX mode) the line is opaque.
- **`sh`** is for a line that may run in bash or in a POSIX shell such as `dash`: a host without bash, or a sandbox whose guest may lack it. It is the `bash` reading with every construct the two shells read differently made opaque (`$'…'`, `$"…"`, `|&`, `&>`, `<<<`, arrays, `[[`, `((…))`, brace expansion, `time`, `select`, `function` and the rest; the full list is in [The bash tool](bash-tool.md#how-the-rules-follow-the-choice)). A caller that does not know which shell runs a line gets `sh`.

In the `bash` dialect it reads:

- quoting: `'…'`, `"…"` (where `\` escapes only `$`, `` ` ``, `"`, `\` and newline), backslash, line continuation, `$'…'` with its escapes decoded (`\n`, `\t`, `\xHH`, `\x{…}`, `\uHHHH`, `\UHHHHHHHH`, `\nnn`, `\cX`, `\'`, `\"`, `\\` and the rest), and `$"…"`;
- the extent of every expansion: `$name`, the special parameters (`$$ $? $! $# $- $@ $* $0`–`$9`), `${…}` with nested quotes, `$(…)`, `` `…` ``, `$((…))`, `$[…]`, `<(…)`, `>(…)` and bash 5.3's `${ …; }`;
- control operators (`;`, `&`, `&&`, `||`, `|`, `|&`, `;;`, `;&`, `;;&`, newline), comments, reserved words, `( )`, `{ }`, `if`, `while`, `until`, `for`, `select`, `case` and `[[ ]]`;
- redirections, including a descriptor (`2>`, `{fd}>`), and here-documents, whose bodies are consumed and never read as commands;
- `bash -c '<payload>'` and the same for `sh`, `dash`, `zsh`, `ksh`, `ash`, `mksh` and `busybox sh`, with option clusters (`-lc`, `-o pipefail -c`): the decoded payload is read the same way, up to four levels deep, in the `bash` dialect for `bash` and the `sh` dialect for the others. A `zsh`, `ksh` or `mksh` payload is also opaque, because those shells go beyond POSIX in ways the lexer does not model. The shell is matched by its basename exactly as written: `bash.exe -c`, `powershell -c`, `pwsh -c`, `fish -c` and `tcsh -c` are not followed. `nestedShellCommand(words)` (exported, with `NESTED_SHELLS`) gives this decision for one command's words without its assignments: the payload the reading holds, the reason it is opaque instead, or `null` when it reads none. A host that decides on the reading uses it to tell text the reading already holds from text a program runs unread; the CLI's scheduled-run floor took any shell at a command's head followed by `-c` as read, and `powershell -c 'namzu schedule stop'` was read by nothing.
- `$(…)` and backtick bodies: read as a command list of its own, the same way — each command inside is in `commands`, marked `origin: 'substitution'`, and the containing word is still flagged as expanding. Unlike a `bash -c` payload, a substitution whose body does not parse cannot be isolated the way a syntax error elsewhere can (finding where a `$(…)` ends requires the parse to succeed, since its closing `)` may be inside a quoted string or a `case` pattern): such a substitution makes the WHOLE line opaque, the same as any other internal error. Two shapes stay opaque outright, proven against real bash (5.2.21, 5.3.15): a substitution beside brace expansion in the same word (`$(cmd){a,b}` runs `cmd` once per alternative), and an unquoted substitution used as a `<`/`>` redirection target (a `${var:-…}`-style default value can run its substitution twice when the target turns out ambiguous — quoting it rules this out). `${ list; }` (bash 5.3's brace-form substitution) is unchanged, always opaque.

For each simple command it reports every word as bash passes it, after quote removal and before expansion, and flags each word whose text is not its runtime value: one holding a parameter, command or arithmetic expansion, a glob, a brace expansion, a tilde, or an escape whose value depends on the locale. An unflagged word is exactly the argument bash passes. It also reports each command's redirections, every redirection in the line (a compound command's included), a here-document's body as written (`ShellRedirection.body`), the words that belong to no simple command — a `for` or `select` loop's variable and list, a `case` statement's subject and patterns (`compoundWords`) — whether the parse completed, and `opaque` with the reasons.

# When a line is opaque

`opaque` means the commands listed may not be everything the line runs. The lexer sets it rather than guess, for:

- a process substitution (`<(…)`, `>(…)`), including one inside a here-document body that expands, inside `${x:-…}` (`${x:-<(cmd)}` runs `cmd`) or inside an array subscript. A command substitution (`$(…)`, backtick) in any of those places is read the same recursive way described above, not opaque on its own;
- arithmetic that names a variable (`$((x))`, `((x))`, `${a[i]}`, `${x:i}`, `${!x}`), because bash evaluates a variable's value as arithmetic, and a value such as `a[$(cmd)]` runs `cmd`; arithmetic on literals is transparent;
- `[[ … ]]`, whose operands are arithmetic in places;
- a function definition or `coproc`, whose body runs under a name no rule sees;
- `time` followed by an option, which the two modes read differently;
- a command that changes how later text is parsed: `shopt`, `enable`, `set -o posix`, `set -k`, or an assignment to `POSIXLY_CORRECT` or `BASH_COMPAT`;
- a syntax error or an unterminated quote, and a construct nested past the limit or too costly to read (the lexer is linear in the line, and 200 KB of the shapes that invite re-reading takes about 200 ms at most);
- two places where bash itself reads a line two ways. Inside double quotes its parser pairs `$$`, so a `(` or `{` after it is text as far as the extent of the string goes, while its expander reads the second `$` as starting `$(…)` or `${…}`: `a "$${x:-"'$(cmd)'"}"` runs `cmd`, which the parse saw single-quoted. And bash 5.2 expands the target of `>&` twice, so `x >&2'$(cmd)'` and `x >&2${v:-'$(cmd)'}` run `cmd` there (5.3 does not). A `$$` followed by `(` or `{` in double quotes, and a `>&` or `<&` target that is quoted or expands, are opaque.

`decomposeCommandLine` adds `eval`, `source` and `.`, which run text assembled at runtime.

An opaque line is never allowed by an `argument_pattern` allow rule and never covered by a skill pattern. Deny rules still test every command the lexer did see, commands inside substitutions included.

# How rules use it

**Deny** matches when the pattern matches the whole value, any command's source text, or any command's words joined by spaces (`decodedCommands`), with and without leading assignments. So `^git push` denies `'git' push`, `g\it push`, `$'\x67it' push`, `GIT_DIR=. git push`, `bash "-c" "git push"`, `! git push` and `echo "$(git push)"`.

**Allow** matches only when every command's source text matches and the line is not opaque. The subject stays the source text, so a pattern that names quotes means what its author wrote.

A value that is one plain command comes back as itself, byte for byte, so a rule about the whole value keeps seeing what it always saw. A value in an argument the tool declares as its path argument (`pathArgument`) is not read as shell at all: `app/(auth)/page.tsx` is a file name, not a syntax error.

**Writes.** `writesThroughRedirection` is true when any redirection opens a file for writing (`>`, `>>`, `>|`, `<>`, `&>`, `&>>`, `>&file`) whose target is not exactly `/dev/null`, when a target expands at runtime (`> "$OUT"`, `> ~/x`), when the line holds a process substitution, and when the line does not parse. Descriptor duplication and closing (`2>&1`, `>&2`, `3>&-`) and anything quoted out of being an operator are not writes. `$'…'` targets are decoded, so `> $'/dev/nul\x6c'` is `/dev/null`.

# Deciding in code

A rule that is not a pattern at all is an `AuthorizationRule` of type `predicate`: `{ type: 'predicate', description, decide, describe? }`. `decide` receives the call (`toolName`, `toolInput`, `toolDef`, and `commandDialect`: the caller's, or `sh`) and returns `allow`, `deny`, `review`, or `null` to let the next rule decide. It sits in the rule list like any other rule, so the dangerous-command floor still comes before it and first match still wins. A `decide` that throws is read as `deny`. `description` is the reason the gate reports when the rule decides, and should tell a model whether another input could fare better.

A rule that refuses on several grounds can also say which one this call hit: `describe(call)`, optional, is asked only after `decide` returned a decision, with the same call, and what it returns is the gate's reason instead of `description` (`GateEvaluationResult.reason`, and so the `Blocked by the authorization gate: …` text the model reads). Returning `null` or an empty string, or throwing, leaves `description`. `describeRule(rule, call)` gives the same sentence to a caller driving the rules with `evaluateRule`. The CLI's scheduled-run floor uses it to name the word, argument or redirection that matched, where it used to list everything it protects.

It exists for rules about what a command line does, which a regular expression over the line's text can only approximate: the pattern has to re-implement bash's quoting, and each form it misses is a way past it. `predicate` code reads the line with `lexShellCommandLine` in `commandDialect` and decides on the words. The CLI's [scheduled-run floor](../cli/scheduled-tasks.md#what-a-run-may-do) is one.

# What it does not do

It is a lexer, not an interpreter. It does not follow `env git push`, `command git push`, `xargs sh -c` or `sudo`, and a deny rule meant to catch those has to name them. The `sh` dialect's agreement with `dash` is by construction, not by measurement: `dash` is not installed where the differential check runs, so what makes a line transparent in `sh` is only what POSIX and bash agree on.

# How it is checked

`packages/sdk/src/authorization/__tests__/shell-lexer-bash.test.ts` asks the bash on the test machine what it runs. PATH names an empty directory, every builtin that could act or stand in for a command is disabled, and `command_not_found_handle` records each argv; each line runs twice, with the handler succeeding and failing, so both sides of `&&` and `||` are seen. Each line is read in both dialects. Where bash reports a syntax error the lexer must say opaque, and where the lexer does not say opaque every command bash ran must be one it listed, word for word, with a flagged word standing for any run of words. The committed test covers every sequence of up to three tokens over the characters that matter to quoting and control, a seeded random sample and the known cases. Before it landed, the same check ran every sequence of up to five tokens (2.9 million lines) and 500 000 random lines against bash 5.2.21 and 5.3.15 with no mismatch, and every sequence of up to four tokens and 160 000 random lines again in POSIX mode; the `sh` dialect ran every sequence of up to four tokens and 40 000 random lines against both versions in both modes. That is how the two double readings above were found.
