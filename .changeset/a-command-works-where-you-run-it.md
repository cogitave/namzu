---
'@namzu/cli': minor
---

Your own slash commands now work in `namzu run` and `namzu run-stream`, not only
in the terminal agent.

Before this, `namzu run "/review src/parse.ts"` sent that string to the model as
prose. The model tried to make sense of it and answered about something else, at
exit 0 — the command had not failed, it had quietly done something different.
Running one from a script is most of the reason to write one, so this was the
larger half of the feature missing rather than a boundary.

**A leading `/` still does not make something a command.** `namzu run
"/usr/local/bin is missing"` is an ordinary prompt and is sent as written. What
makes it a command is the first word naming one your project declares: a file in
`.namzu/commands/` is an explicit declaration, and a word that merely starts with
a slash is not. Prompts that begin with a slash keep working.

Built-in commands are interactive and do nothing headless. A prompt that is
exactly one — `namzu run "/help"` — is refused with a message instead of being
sent, because nobody means that literally. `namzu run "/clear the cache in
redis"` passes through untouched; the extra words are what distinguish a request
from an invocation.

A command that cannot run — arguments a template has no `$ARGUMENTS` to receive,
or frontmatter that will not parse — exits non-zero with the reason and sends
nothing. A script continuing on a misfired command is the outcome worth
preventing.
