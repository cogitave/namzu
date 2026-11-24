---
name: debug
description: Find out why Namzu itself is misbehaving in this session or setup, from its own logs and settings. Use when the person types /debug, or says Namzu crashed, hung, ignored a setting, or showed an error they cannot explain. Not for bugs in the project's own code.
invocation: operator
argument-hint: '[what went wrong]'
---

# Investigating Namzu's own trouble

$ARGUMENTS

## Steps

1. **Pin down the symptom.** What did the person do, what did they expect, what
   happened, and since when (a new version, a changed setting, a new machine).
   One short question if you cannot tell.
2. **Run the health check**: `namzu doctor`. It checks sign-ins, the sandbox,
   the scheduler, the browser, folders and more, in plain words. A failing row
   is the first lead; do not go further until you have read all of them.
3. **Read the record of what happened.**
   - A crash leaves `crash-<time>.log` in the `logs` folder of the Namzu home
     (`~/.namzu/logs/`, the newest ten are kept).
   - The conversation's own log is the newest `<session-id>.jsonl` under the
     project's folder in the Namzu home (`~/.namzu/projects/<slug>/`). Read its
     last 50 lines and search it for `error`, `refused`, `denied` and
     `timeout`. Read, never change it.
   - To see the technical text that is normally hidden (the provider's error,
     the cause of a failure, a stack), start Namzu again with `--debug` or
     `NAMZU_DEBUG=1` and repeat what went wrong.
4. **Check the settings that could cause it**: `namzu config list` for the
   related ones, and the layers they come from (`~/.namzu/config.yaml`,
   `.namzu/settings.json`, `namzu.config.json`, `.namzu/settings.local.json`,
   `NAMZU_` variables). A setting set in a closer layer wins over a farther one.
   `namzu hooks` shows hooks that load or fail to.
5. **Form two or three hypotheses**, each with the evidence for and against it
   from what you read. Test the likeliest with the smallest harmless step.
6. **Report**: the cause if you found it with the line that shows it, or the
   best lead and what would settle it; what the person can do (a setting, an
   update, a retry); and what you did not look at.

## Never

- Show the person a secret that sits in a log or file (keys, tokens, cookies);
  say it is there and where.
- Change a setting, delete a log or reinstall without asking first.
- Upload logs or session files anywhere.
- Guess a cause and present it as found.
