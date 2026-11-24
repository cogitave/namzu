---
name: fewer-permission-prompts
description: Look through this project's past sessions for read-only commands the person keeps being asked about, and propose a short allow list for them. Use when the person types /fewer-permission-prompts, or complains about being asked too often. Not for turning off checks and not for allowing commands that change things.
invocation: operator
argument-hint: '[how many sessions to read]'
---

# Fewer permission prompts

A prompt for a command that only reads is a cost with no safety in return. The
goal is a short list of narrow rules for those, written where the person
chooses, with nothing broader than what they already do.

$ARGUMENTS

## Steps

1. **Find the sessions.** Conversations of the project you are in are kept as
   `<session-id>.jsonl` files under the project's folder in the Namzu home
   (`~/.namzu/projects/<slug>/`; `namzu doctor` or the person can name it). Take
   the newest 30 unless the person gave a number. Each line is one record; look
   at a few lines first with `head -c 2000` to learn the field names before you
   write a filter. Read the files, never change them.
2. **Collect the commands that were run** through the shell tool, with how
   often each came up and whether the person was asked about it. Group by the
   command and its leading arguments (`git log`, `pnpm test`, `ls`), not by the
   full line.
3. **Keep only what is safe to allow.** A command qualifies if it reads and
   changes nothing: `git status`, `git diff`, `git log`, `ls`, `cat`, `grep`,
   `rg`, `find` without `-delete` or `-exec`, `pwd`, `wc`, version checks,
   `namzu doctor`. A test or lint command qualifies only when it is the
   project's own and it writes nothing outside the project.
4. **Throw out the rest, and say so.** Never propose: anything that deletes,
   writes, installs, pushes, sends, or reaches a network service; an
   interpreter or launcher (`python`, `node`, `bash`, `sh`, `npx`, `npm run`,
   `pnpm run`, `env`, `sudo`, `ssh`, `xargs`, `make`), because a rule for one
   allows any program; a bare tool name with no arguments pattern; a pattern
   with a wildcard in the first word.
5. **Rank by how often the person was asked**, and keep the top 10 to 15 rules,
   each written as narrowly as it was used: `git diff *` rather than `git *`.
6. **Show the proposal** as a table: the rule, how many times it came up, and
   one real example. Say what is not included and why, in one line.
7. **Wait for a yes, then write only the rules they accept**, into
   `.namzu/settings.local.json` (this computer, not committed) under
   `permissions`, keeping every other key (`namzu config set permissions ...`
   writes the user file instead, and asks first). Read the file back to check
   it is still valid, and tell the person to start a new session or use
   `/permissions` to see the rules.

## Never

- Add a rule the person did not accept, or one that allows more than what the
  sessions show.
- Change a permission mode, turn on bypass, or remove an `ask` or deny rule.
- Read other projects' sessions, or copy command output (it can hold secrets)
  into the proposal; commands only.
- Do anything that cannot be undone (delete data, push, spend money) without
  asking first.
