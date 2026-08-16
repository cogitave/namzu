---
'@namzu/cli': minor
---

The command list is what this host owns plus whatever the kernel's registry
reports, instead of one hardcoded array.

`SLASH_COMMANDS` was a literal, and nothing a capability added could reach
the operator without editing that file. The coupling had already escaped
the TUI: two headless commands imported the array for a name list, so a
name they did not know went to the MODEL as prose — both a wrong answer and
a tool call nobody asked for.

`CLI_LOCAL_COMMANDS` now holds only what this host genuinely owns — a
transcript, a picker, a login, an expand — and `mergeHostCommands` appends
the registry's. `/agents` and `/tasks` are the kernel's now, and
`SlashContext.agentIds` is gone: the roster is the kernel's fact, and the
CLI carrying a second copy meant two answers to one question that could
disagree.

A name claimed by both throws at merge time naming it, rather than letting
local win quietly. One of the two would never run, which one depends on
merge order, and neither the kernel nor the host author would ever see it.

Dispatch is a new `SlashAction` kind rather than an async action, because
the registry's handlers read stores and this union is synchronous — naming
the dispatch as a result keeps that boundary where it is, and the App's
exhaustive `never` default still fails the build for an unhandled kind.
