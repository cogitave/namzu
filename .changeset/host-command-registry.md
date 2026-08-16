---
'@namzu/sdk': minor
---

`HostCommandRegistry` is a seam for the commands a host offers its
operator. There was none — the whole vocabulary was a literal array in one
host's TUI module, over a union shaped by that TUI's own concerns, and the
coupling had already escaped it: two non-TUI commands import that array
from React-adjacent code to build a name list, for facts the kernel owns.

**Deliberately not tools.** No descriptor reaches a provider and no
dispatch path reaches the model. A `/tasks` readout is a question the
operator asked; making it callable would let the model spend a turn on it
and record the output in the transcript as if it had discovered something.

Outcomes are structured, not rendered: `report` with rows, `prompt`, `ack`,
`refused`. The SDK formats nothing, because a TUI draws a table, a JSON
command prints a document and a web host renders a component — and a
pre-rendered string forces all three to parse prose back into the fields it
was built from.

`dispatch` returns `undefined` for a name it does not know, which is not
`refused`. A host layers its own commands under these, and collapsing "not
mine, keep looking" into "mine, and no" makes every one of them
unreachable.

`describe()` strips handlers, so a descriptor survives both
`JSON.stringify` (which drops a function silently) and `structuredClone`
(which throws on one).

A name collision throws rather than warning and overwriting, unlike the
base registry: these are operator-facing, and a shadowed command does not
fail — it simply never runs, and which one wins depends on registration
order.

Filled with the two commands whose facts the kernel already owns:
`kernelHostCommands` provides `/tasks` and `/agents`. An empty registry is
a declaration, and `/tasks` refuses rather than reporting zero when there
is no task store, because "there are none" and "I have nothing to measure
with" are different answers.
