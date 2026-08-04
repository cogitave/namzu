---
'@namzu/sdk': major
---

Two allow-lists in the delegation surface stop failing open, and a host can
now decline a coordinator tool.

## An empty delegate roster means nobody

`create_task` derived its `agent_id` parameter from `allowedAgentIds` but
widened it from the roster enum to a bare string whenever that roster was
empty — so the one configuration meaning "this run may delegate to nobody" was
the only one that let the model name anybody. An allow-list *is* the
enumeration of what is permitted; an empty one enumerates nothing and admits
nothing. Degrading it to an open string to keep functioning is failing open
(CWE-636), and the rule it breaks is fail-safe defaults (Saltzer & Schroeder
1975, §I.A.3(b)), restated in NIST SP 800-53 Rev. 5 as SC-7(5) "deny by
default, allow by exception".

What that reached is why this is worth a break. The id was not merely rejected
downstream: it went to the gateway, which resolves against an `AgentManager`
that is typically **shared**, so an agent the host deliberately left out of
`agentIds` could still launch if it happened to be registered there. When it
was not registered, the failure text listed every registered agent id back to
the model, and the plan row was left stranded at `in_progress` because the
store write precedes the gateway call while the reconciling update follows it.

`create_task` is now **not mounted** when the roster is empty, rather than
mounted with a schema nothing satisfies — refusing per call reaches the same
verdict while paying prompt-prefix tokens and an iteration for it (NIST SP
800-53 CM-7, least functionality). It is the only coordinator tool that reads
the roster, so `agent_task_list`, `approve_plan` and `ask_user_question` are
untouched: "no delegates, but still planning and a human channel" remains a
supported configuration. The schema stays closed underneath as defence in
depth. If you construct a supervisor with `agentIds: []` and expected
`create_task` to be callable, populate the roster — there is no flag that
restores the old shape, because the old shape could not correctly succeed.

`buildAgentTool` carried the identical fallback and now throws at construction
instead: it returns exactly one tool and that tool *is* the delegation surface,
so "do not mount it" and "do not build it" are the same statement. It also
never checked `subagent_type` against the roster inside `execute`, which is
reachable without going through the registry; it does now.

## A host can decline a coordinator tool

`runtimeToolOverrides` is this SDK's declared way to decline a kernel-mounted
tool. It is honoured for the task tools and the advisory tools, and
`SupervisorAgent` forwards it into its own `drainQuery` call — but it
registered the coordinator tools before that, unconditionally, so
`{ create_task: 'disabled' }` was obeyed everywhere except the one surface a
host would most want to decline. A run that must not delegate had prompt text
and a gateway refusal as its only defences. This half is pure gap-closure: the
mechanism, the type and two other call sites already existed, and coordinator
registration now uses the same idiom.

## Collisions refuse instead of overwriting

This half is new policy, not a gap-closure. Registration now throws
`ToolNameCollisionError` (exported, carrying `toolName`) when a coordinator
tool's name is already registered on the supervisor's `tools`, instead of the
registry's warn-and-overwrite. The reserved names are `create_task`,
`agent_task_list`, `approve_plan`, and `ask_user_question` — grep for those
four.

The old behaviour was not "the host's tool quietly loses and the run works".
`registerOne` ends by setting availability, and the coordinator call passed
none, so a tool the host registered `deferred` or `suspended` was silently
promoted to `active` under someone else's implementation; and because the
backing store is a `Map`, the replacement inherited the host's insertion
position in the prompt-cache prefix. That is a different authorization surface,
not a lost registration — detection of an error condition without action
(CWE-390), where CWE-694's own mitigation is nearly this fix. Complete
mediation is the principle (§I.A.3(c)): a registry entry is a remembered
binding of a name to an authority, and rebinding it leaves every decision made
about the old binding stale.

To migrate: rename your tool, or keep your name and decline the coordinator one
with `runtimeToolOverrides: { "create_task": "disabled" }`. The error names
both routes.
