---
"@namzu/cli": minor
---

Every skill you can invoke is now also a slash command, `/<name> [arguments]`. The skill's body is the prompt and `$ARGUMENTS` in it is replaced by the text after the name; arguments given to a skill whose body has no `$ARGUMENTS` are refused with the file named. A skill or command file can declare `argument-hint: [issue-number]`, which the composer shows dimly after `/<name> ` and the command list shows beside the description. A skill with `user-invocable: false` or `invocation: model` gets no command, and a command file of the same name still wins over a skill. `/skills <name>` still activates a skill for the whole conversation. Nothing to change: a `/word` that used to answer "Unknown command" now runs the skill of that name if you have one. In `namzu exec`, `/<name>` runs only skills you wrote in your own or the project's skill folders; the ones that ship with Namzu stay plain prompt text there.
