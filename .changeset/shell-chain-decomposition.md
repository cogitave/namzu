---
'@namzu/sdk': major
---

`argument_pattern` reads a command line as the commands it runs, not as one string

An anchored pattern was tested against the argument's whole value, so a rule
matching `^git push` saw `git push origin main` and did not see
`true; git push origin main`. A rule that fails to match reaches the permission
mode, and a run with no terminal resolves that to `auto` — so an operator's
prohibition was bypassed by typing four characters in front of it, in exactly
the unattended case the prohibition exists for. The `bash` tool's own
description tells the model to use `&&` / `;` chaining, so the evading form is
the documented one rather than an exotic input.

The rule now decomposes the value into its commands — chain operators, subshell
grouping and a nested `sh -c` payload, with quoting respected — and the two
decisions read that decomposition differently:

- `deny` matches when **any** command on the line matches.
- `allow` matches only when **every** command on the line matches, and never
  when the line runs something the decomposition cannot see (`$(…)`, backticks,
  `<(…)`, `eval`).

**What breaks.** An `allow` rule stops approving a chain that carries a command
it does not name: `git status && rm -rf ~` was approved by a rule written for
`^git status` and is now left undecided, falling through to the permission mode.
A `deny` rule refuses more than it used to, which is the change it exists for.
To keep a compound line approved, write a pattern that matches every command on
it, or approve the tool by name.

A value with no chain operator, no nested shell and nothing opaque is matched
exactly as before, byte for byte, so rules about a path, a URL or a number are
unaffected.

`ToolDefinition` and `defineTool` gain an optional `commandArgument`, naming the
argument that holds a command line — `bash` declares `command`. A host
compiling operator permissions has a tool name and needs an argument to attach a
pattern to, and every other way of learning that is a list elsewhere that
drifts. `builtinCommandArguments()` and `commandArgumentOf()` read it back.
