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

Before this reader there were three hand-written walkers, one per purpose, each with its own copy of bash's quoting rules. Each rule of bash's had to be added to all of them, and each place one was missed was a line whose commands the rules did not see.

# What it reads

The lexer follows bash 5 in its default (non-POSIX) mode:

- quoting: `'…'`, `"…"` (where `\` escapes only `$`, `` ` ``, `"`, `\` and newline), backslash, line continuation, `$'…'` with its escapes decoded (`\n`, `\t`, `\xHH`, `\x{…}`, `\uHHHH`, `\UHHHHHHHH`, `\nnn`, `\cX`, `\'`, `\"`, `\\` and the rest), and `$"…"`;
- the extent of every expansion: `$name`, the special parameters (`$$ $? $! $# $- $@ $* $0`–`$9`), `${…}` with nested quotes, `$(…)`, `` `…` ``, `$((…))`, `$[…]`, `<(…)`, `>(…)` and bash 5.3's `${ …; }`;
- control operators (`;`, `&`, `&&`, `||`, `|`, `|&`, `;;`, `;&`, `;;&`, newline), comments, reserved words, `( )`, `{ }`, `if`, `while`, `until`, `for`, `select`, `case` and `[[ ]]`;
- redirections, including a descriptor (`2>`, `{fd}>`), and here-documents, whose bodies are consumed and never read as commands;
- `bash -c '<payload>'` and the same for `sh`, `dash`, `zsh`, `ksh`, `ash`, `mksh` and `busybox sh`, with option clusters (`-lc`, `-o pipefail -c`): the decoded payload is read the same way, up to four levels deep.

For each simple command it reports every word as bash passes it, after quote removal and before expansion, and flags each word whose text is not its runtime value: one holding a parameter, command or arithmetic expansion, a glob, a brace expansion, a tilde, or an escape whose value depends on the locale. An unflagged word is exactly the argument bash passes. It also reports each command's redirections, every redirection in the line (a compound command's included), whether the parse completed, and `opaque` with the reasons.

# When a line is opaque

`opaque` means the commands listed may not be everything the line runs. The lexer sets it rather than guess, for:

- a command or process substitution, including one inside a here-document body that expands, inside `${x:-…}` (`${x:-<(cmd)}` runs `cmd`) or inside an array subscript;
- arithmetic that names a variable (`$((x))`, `((x))`, `${a[i]}`, `${x:i}`, `${!x}`), because bash evaluates a variable's value as arithmetic, and a value such as `a[$(cmd)]` runs `cmd`; arithmetic on literals is transparent;
- `[[ … ]]`, whose operands are arithmetic in places;
- a function definition or `coproc`, whose body runs under a name no rule sees;
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

# What it does not do

It is a lexer, not an interpreter. It does not follow `env git push`, `command git push`, `xargs sh -c` or `sudo`, and a deny rule meant to catch those has to name them. It reads a nested `sh -c` payload as bash would, which is what `sh` is on hosts where it is bash; `dash` differs in places (`$'…'`, `|&` and `&>` among them). The `bash` tool runs its command through `/bin/sh -c`, so on a host whose `/bin/sh` is `dash` the reading is bash's and not the one that runs.

# How it is checked

`packages/sdk/src/authorization/__tests__/shell-lexer-bash.test.ts` asks the bash on the test machine what it runs. PATH names an empty directory, every builtin that could act or stand in for a command is disabled, and `command_not_found_handle` records each argv; each line runs twice, with the handler succeeding and failing, so both sides of `&&` and `||` are seen. Where bash reports a syntax error the lexer must say opaque, and where the lexer does not say opaque every command bash ran must be one it listed, word for word, with a flagged word standing for any run of words. The committed test covers every sequence of up to three tokens over the characters that matter to quoting and control, a seeded random sample and the known cases. Before it landed, the same check ran every sequence of up to five tokens (2.9 million lines) and 500 000 random lines against bash 5.2.21 and 5.3.15 with no mismatch; that is how the two double readings above were found.
