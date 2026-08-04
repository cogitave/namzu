---
'@namzu/sdk': major
---

Two allow-lists in the supervisor's delegation surface stop failing open.

**An empty delegate roster now refuses every delegation.** `create_task`
derived its `agent_id` parameter from `allowedAgentIds`, but widened it from
the roster enum to a bare string whenever that roster was empty — so the one
configuration that says "this run may delegate to nobody" was the only one
that let the model name anybody. The call still failed, one layer down, with
"no such agent"; the message pointed at a missing registration rather than at
an empty roster. An allow-list that admits everything when it is empty is the
fail-safe-defaults violation Saltzer & Schroeder named in 1975 (§3.A.2) and the
defect catalogued as CWE-183. If you construct a `SupervisorAgent` with
`agentIds: []` and expected `create_task` to be callable, populate the roster —
there is no flag that restores the old shape, because the old shape could not
succeed.

**A host can now decline a coordinator tool, and the kernel will not take a
name the host already used.** `runtimeToolOverrides` is this SDK's declared way
to decline a kernel-mounted tool; it is honoured for the task tools and the
advisory tools, and `SupervisorAgent` forwards it into its own `drainQuery`
call — but it registered the coordinator tools before that, unconditionally, so
`{ create_task: 'disabled' }` was obeyed everywhere except the one surface a
host would most want to decline. A run that must not delegate had prompt text
and a gateway refusal as its only defences. Coordinator registration now
consults the same overrides, in the same shape as every other kernel-mounted
tool in this SDK.

Registration also refuses on a name collision instead of overwriting. Two
sources contributed the same tool name and nothing here ranks them: the
coordinator tools are the kernel's, and `config.tools` belongs to the embedding
host — the most trusted party present, not a plugin whose shadowing can be
dropped on trust grounds. The registry resolved that by warning and replacing,
which is a fine registry default and the wrong answer for a contract surface:
the model kept a `create_task` whose behaviour depended on registration order,
and a log warning is not something a host can act on before the run starts.

If you register a tool named `create_task`, `continue_task`, `cancel_task`,
`agent_task_list`, `approve_plan`, or `ask_user_question` on a
`SupervisorAgent`'s `tools`, that run previously started with your tool
silently replaced and now throws at startup. Keep your name by declining the
coordinator one — `runtimeToolOverrides: { create_task: 'disabled' }` — or
rename your tool. The error names both routes.
