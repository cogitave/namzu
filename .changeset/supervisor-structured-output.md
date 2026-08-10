---
'@namzu/sdk': minor
---

A supervisor can be held to a schema, like the archetype beside it

`ReactiveAgent` has forwarded `structuredOutput` since the field existed.
`SupervisorAgentConfig` never declared it, and nothing in that file said why —
in a file where `maxDepth`, `allowDelegation`, `maxToolConcurrency` and
`siblingFailurePolicy` each carry a paragraph of argument for what they do and
do not cover. The kernel path is archetype-blind: `drainQuery` registers
`structured_output` from this config and the iteration loop captures it, so the
capability was always reachable through the raw kernel entry point and only the
hop from the surface hosts construct was missing.

Two hops were missing, in fact. `SupervisorAgent`'s result literal also did not
copy `run.structuredOutput`, while `ReactiveAgent`'s does —
`BaseAgentResult.structuredOutput` names "an archetype's result literal did not
copy it" as one of the defects it was written to close, and that defect was
still live in the sibling nobody checked. Wiring only the config would have
produced a settable field whose answer the host could not read.

**What this buys, stated plainly, because it is less than it sounds like.**
Structured output is terminal and exclusive by policy: `setStructuredOutput`
overwrites the run's result behind a sticky flag and the run ends on the turn
that produces the value. So this gives a supervisor a schema-constrained **final
answer** and nothing more. It does not shape a delegated child's answer — a
child carries its own config, so a host wanting typed worker results sets the
schema on the workers. It is not a return type for the fan-out, and it does not
arrive alongside prose.

One consequence a supervisor host in particular should know: because the answer
decides the run, delegated work still running when it lands is walked away from
rather than waited for. It is recorded — the run names it on `abandonedTaskIds`
— but no further turn delivers it. A supervisor that must read every child
before answering should wait for them and call `structured_output` after.

`minor`: additive. `SupervisorAgentConfig.structuredOutput` is optional and
`SupervisorAgentResult.structuredOutput` was already declared on
`BaseAgentResult`, so nothing narrows, nothing is renamed, and a supervisor
configured without a schema runs the path it ran before.
