---
name: update-config
description: Change Namzu's settings, permissions, hooks or environment for the person, in the right place and with the right checks. Use when the person types /update-config, or asks to allow a command, turn a setting on or off, "from now on when X do Y", or add a hook. Not for the project's instructions file and not for a skill.
invocation: operator
argument-hint: '[what to change]'
---

# Changing Namzu's configuration

$ARGUMENTS

## Where a setting lives

Settings are read in layers; the later ones in this list win:

| Layer | File | Who it belongs to |
| --- | --- | --- |
| User | `~/.namzu/config.yaml` (`$NAMZU_HOME/config.yaml`) | this person, every project |
| Project, shared | `.namzu/settings.json`, `namzu.config.json` | the repository; committed |
| Project, this computer | `.namzu/settings.local.json` | this person here; not committed. "Don't ask again" answers go here |
| Environment, flags | `NAMZU_…` variables and command line flags | one run |

A project file cannot open some doors (bypass mode, where worktrees go, the
`routing` section): those are read from the person's own file only.

## Steps

1. **Understand the request.** What should be true afterwards, for whom (just
   this person, this computer, or everyone on the project), and for how long.
   Ask one short question if that decides the file.
2. **Is it a described setting?** `namzu config list` shows every one with its
   key, `namzu config get <key>` shows its choices and default, and
   `namzu config set <key> <value>` writes the user file through the same
   checks Desktop Settings uses (and asks before the risky ones). Use it when
   the key is listed; do not edit the YAML by hand for those.
3. **"Whenever X happens, do Y" means a hook, not a note.** A reminder in a
   memory or a message does not make anything run; only a hook does. Hooks live
   in a `hooks` block of a settings file, an event name with a matcher and a
   command, for example:

   ```json
   { "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "./guard.sh", "timeout": 5 } ] } ] } }
   ```

   Build it in small steps: write the command and run it by hand on a sample
   first; add the entry; check it with `namzu hooks`, which lists what loads
   and what does not, and with `/hooks` in a session. Say where it will run
   and what it can see.
4. **A permission** is a rule such as `permissions: {bash: {"git status *": "allow"}}`.
   Allow narrowly (one command and its arguments, not a whole interpreter
   such as `python *` or `bash *`, which allows anything). Put it in
   `.namzu/settings.local.json` unless the person wants the team to have it.
5. **Show the exact change before you make it**: the file, the key and the new
   value, and what it will do. Wait for a yes. Make the smallest edit, keep the
   file's other keys and comments, and keep valid JSON or YAML.
6. **Check it took.** Read the value back with `namzu config get <key>` or run
   `namzu doctor`; for a hook, the `namzu hooks` listing. Tell the person
   whether it applies now or from the next session.

## Never

- Weaken a safeguard to make a prompt go away: no bypass mode, no wide allow
  rule, no turning off a check, unless the person says that is what they want
  after hearing what it allows.
- Put a secret in a file that is committed.
- Edit a managed or system file, or change anything for other people.
- Do anything that cannot be undone (delete data, push, spend money) without
  asking first.

## Not for

The project's instructions file (`AGENTS.md`) and skills: those are written
with `write` and `skill-creator`.
