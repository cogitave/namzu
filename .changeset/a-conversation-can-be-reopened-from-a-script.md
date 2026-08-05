---
'@namzu/cli': minor
---

`namzu run --continue` and `--resume <id>` reopen a previous conversation

The store, the reader and the picker all existed — a conversation you could
reopen inside the TUI with `/resume` could not be reopened from a script,
because only the entry point was missing.

`--continue` takes the most recent conversation in the working directory;
`--resume <id>` takes the one you name.

**Both refuse when the conversation cannot be reopened, and neither ever falls
back to starting a new one.** Someone who types `--resume` is asking for *that*
conversation; silently starting a fresh one hands back something
indistinguishable from what they asked for, and they find out several turns
later having already acted on it. Resuming with a partial transcript is worse
still — a half-context is not a degraded context, it is a different context that
lies about being complete.

The refusal names the cause rather than the outcome, because the causes have
different fixes: "no previous conversation in /path" points at `--cwd`, which is
usually the real mistake, while an unknown id says how many others are there.

There is deliberately no way to spell "resume if you can, otherwise start" — run
with no flag for that.
