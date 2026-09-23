---
"@namzu/sdk": patch
---

Permission rules on a command line now read it the way bash does. A `deny` rule catches commands it used to miss, and a few lines that used to be approved or refused by accident are now decided on what they run.

An `argument_pattern` rule on a command argument, a skill's `Bash(<pattern>)` entry and the check that such an entry never covers a write through redirection used to rely on three separate readers of bash quoting, which disagreed in places. With `Bash(git status *)` granted, `git status $'\'' ; touch pwned #'` and `git status $'\'' > ~/.bashrc #'` were pre-approved, because `$'\''` was read as a closed quote and an open one. One lexer now serves all three (see `docs/sdk/command-lines.md`). It was checked against bash 5.2 and 5.3 on 2.9 million generated lines with no disagreement.

What changes for a host:

- A `deny` rule also matches each command's words after quote removal. `^git push` now denies `'git' push`, `g\it push`, `$'\x67it' push`, `GIT_DIR=. git push`, `bash "-c" "git push"` (the quoted `-c` is still the flag) and `bash -lc 'git push'`. None of these were denied before.
- A line whose only quoting is an ANSI-C quote is decoded rather than refused: an `allow` rule or a `Bash(<pattern>)` entry that matches `git status $'-s'` now approves it, since it runs `git status -s`. `> $'/dev/nul\x6c'` is `/dev/null` and is not a write.
- A here-document body is data, not commands, so `cat <<EOF … EOF` is matched as `cat <<EOF`.
- A line is refused by `allow` (opaque) in some cases it used to approve: a syntax error, `[[ … ]]`, arithmetic on a variable (`$((x))`), `${!x}`, a function definition, `shopt`/`set -o posix`, and two forms bash itself reads two ways (`"$${…"` in double quotes, and a quoted `>&` target, whose substitution bash 5.2 runs). They now go to review.
- A segment no longer carries a trailing comment: `git push #'` is `git push`.
- An `argument_pattern` rule on an argument the tool declares as its `pathArgument` tests the whole value and does not read it as shell, so `src/app/(auth)/page.tsx` is not refused as a syntax error.

No configuration change is needed.
