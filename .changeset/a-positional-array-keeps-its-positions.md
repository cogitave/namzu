---
'@namzu/sdk': major
---

A bridged tool's positional array is no longer flattened to "an array of
anything".

`mcpJsonSchemaToZod` collapsed every positional array — both the draft-07
spelling (`items` holding a list) and the 2020-12 one (`prefixItems`) — to
`z.array(z.unknown())`. The schema makes a round trip, server JSON Schema → Zod
→ JSON Schema on the wire, so what was dropped was dropped from what the MODEL
is shown: a server that spelled out `[string, number]` had the model told
nothing about the positions, their types, or their order.

**Why this is a major.** Where the server pinned the arity and closed the tail,
the converted schema is now a tuple, so input that a looser array accepted is
refused locally. It is only ever refused where the server itself declared it
invalid — the error moves from the server's response to the local validator —
but a host driving a bridged tool directly can see a validation failure it did
not see before, and code branching on the converted type (`instanceof
z.ZodArray`) will take a different branch. If you relied on the permissive
shape, the fix is to send what the server's schema declares.

**The tuple is deliberately narrow, and that is the whole design.** A rejected
tool schema fails the entire request rather than degrading one tool, taking down
every run that offered the toolset — so a faithful conversion the wire will not
accept is strictly worse than a lossy one it will. A tuple is therefore emitted
only where the server pinned the arity AND closed the tail, because that renders
as bounded `prefixItems`, which is the one positional shape measured as
accepted and the same shape a first-party builtin already ships. Every looser
positional array keeps today's permissive array and gains its shape in the
description instead, appended to whatever the server wrote rather than replacing
it.

The inversion worth knowing if you write these schemas: positional members do
not constrain LENGTH. Without `minItems` a server is permitting a shorter array,
which a tuple cannot express — so an absent lower bound is a reason to keep the
loose form, not a detail to round up.

**Also fixed, and reachable from any bridged server:** the conversion's depth
ceiling never fired. `MAX_CONVERSION_DEPTH` was compared against in one branch
that a pure array or union never reaches, and the counter was not even passed
down the array path — so a deeply nested schema from a remote tool listing took
the process down with a stack overflow instead of being left permissive as the
ceiling's own comment promised.
