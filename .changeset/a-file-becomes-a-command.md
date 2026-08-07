---
'@namzu/cli': minor
---

A markdown file is now a slash command.

```
~/.namzu/commands/<name>.md      everywhere
<cwd>/.namzu/commands/<name>.md  this project
```

`review.md` becomes `/review`, and the body is the prompt it sends. A project
command shadows a user one of the same name — the same precedence skills use.
Frontmatter is optional; only `description` is read, and it is what `/help` and
the autocomplete dropdown show.

**Arguments go through `$ARGUMENTS`.** `/review src/parse.ts` substitutes the
path wherever the token appears. A template with no `$ARGUMENTS`, invoked with
arguments, is **refused** — it names your file and the token to add. Running it
would discard what you typed, and a command that silently ignores half its input
is worse than one that stops. A template with no token and no arguments is a
static prompt and runs normally.

Refusing is the reversible direction. Relaxing it later, by appending arguments
somewhere, breaks nobody; tightening an append into a refusal would break
everyone who had come to rely on it.

**A file that will not load is refused, not skipped.** It stays in `/help`
marked `⚠` with the parse error, and the rest keep working. A file named after a
built-in is listed the same way rather than silently ignored — built-ins always
win, and its author needs to know why theirs never ran.

Files are read when the session starts; `/model` or a restart picks up a new
one.
