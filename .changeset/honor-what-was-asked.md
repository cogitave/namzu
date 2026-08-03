---
'@namzu/sdk': minor
---

Three things the model or the host was invited to say, and the kernel discarded.

**Plan step dependencies.** `approve_plan` shows the model `depends_on` on every step, described as "Step descriptions this depends on", and then passed `dependsOn: []` for all of them. The declared ordering was dropped at the one place it entered the system. The visible cost is not scheduling — `PlanManager.getNextPendingStep` holds the dependency gate and currently has no callers — it is the **approval**: `dependsOn` is serialized into the `plan_approval` payload a human reads before saying yes, so a reviewer was shown a plan whose steps all looked independent however carefully the model had ordered them.

Descriptions now resolve to step ids, matched case- and whitespace-insensitively because a model does not reproduce its own strings byte-for-byte. Four things are **refused rather than dropped**, each with the offending text named so the model can correct it and call again: a dependency naming no step, one that two steps could answer, a step depending on itself, and a cycle. The cycle check matters most — no step in a loop can ever start, so the plan does not error, it simply stops making progress with nothing to observe. A diamond is not a cycle and is accepted.

**Advisory context.** Two paths reach an advisor. The trigger path always passed the live messages, working state and tool catalogue. The tool path — the one the *model* uses — passed `{ messages: [], iteration: 0 }`, a literal empty context. So an advisor the model consulted about a situation could not see the situation, and the model's own `include_context: true` had nothing to include. The runtime now supplies the live context through a provider function, read at call time rather than captured at construction, because the tool is built once per run and called at an unknown later point.

That is also where `AdvisoryConfig.includeToolCatalog` and `AdvisorDefinition.useCompactedContext` are read for the first time. Both were declared and consulted by nothing, so a host who turned the catalogue off still paid for it in every advisory prompt.

**Advisory urgency.** `urgency` reached exactly one debug log line, so `'high'` and `'low'` produced byte-identical requests. The advisor is now told, because it is the party that can act on it — one sentence rather than a routing policy this kernel has no business inventing. `'normal'` appends nothing at all: a sentence asserting the ordinary case is prompt weight that changes no answer and makes the two that matter harder to notice.
