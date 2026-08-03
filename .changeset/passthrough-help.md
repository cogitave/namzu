---
'@namzu/cli': patch
---

`--help` on `run`, `run-stream` and `history` now answers instead of
running.

`passThrough` turns commander's `--help` off so a command can parse it
itself — right for the commands that render their own. The three that do
not were receiving `--help` as **input**: for `run` it became the prompt to
send to a model, so a user asking how to use it got "no LLM provider
available"; for `history` it became the session to look up, so they got
`[]`.

`CommandDef.help` fills that in, and the registry answers before the
handler runs. Handling it there rather than in each command is what stops
the fourth one from doing the same thing. A command that renders its own
help sets nothing and is untouched.

Found by running the built binary. Every one of these commands had passing
tests — none of them invoked `--help`, because the suite tested what the
commands do and not what a person types first.
