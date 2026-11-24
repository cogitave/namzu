---
name: commit
description: Write a commit for the current changes, in the style of this repository. Use when the person types /commit or asks to commit what was done. Not for pushing, and not for opening a pull request (use pr).
invocation: operator
argument-hint: '[message or what to include]'
---

# Making a commit

This works in a Git repository. If `git rev-parse --is-inside-work-tree` fails,
say there is nothing to commit to and stop.

$ARGUMENTS

## Steps

1. **Look.** Run `git status --short`, `git diff` and `git diff --staged`, and
   `git log --oneline -15`. Note the branch. If there is nothing to commit, say
   so and stop.
2. **Read the rules for this repository.** Its instructions file (`AGENTS.md`
   or the one the project uses) may fix the commit format, the author, trailers
   and what must run first. Follow it over anything below. A hook on commit that
   fails is a result to read, not something to skip.
3. **Choose what goes in.** Only the files that belong to the change you were
   asked to commit. Leave out files the person was working on that are not part
   of it, build output, logs and anything that looks like a secret (`.env`, keys,
   tokens); name them to the person instead of staging them.
4. **Stage by path**, listing each file: `git add path/one path/two`. Never
   `git add -A` or `git add .`.
5. **Write the message** in the style of the log you read in step 1: the same
   kind of subject (if it follows Conventional Commits, use that with the
   right scope), in the imperative, about 70 characters, and a body only when
   the reason is not obvious: say why, not what the diff already shows. If the
   `attribution` setting holds text (`namzu config get attribution`), end the
   message with it.
6. **Commit** with `git commit -m` and the message, as a command of its own.
   Then run `git log -1 --stat` and show the person the subject and the files.

## Never

- Push, force-push, amend or rebase a commit the person did not ask you to.
- Skip hooks (`--no-verify`) or signing, or change the Git author or settings.
- Commit on a branch the person told you not to touch; if this is the main
  branch and the repository's rules say work goes through a pull request, say
  so and offer to make a branch first.
- Commit secrets or large generated files.
