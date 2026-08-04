---
'@namzu/sdk': minor
---

A human's approval now crosses the spawn boundary.

`BaseAgentConfig` carried no resume handler. `SendMessageOptions.configOverrides` is a `Partial` of it, so a parent could not hand its decision channel to a child **at the type level** — and no runtime path could carry one either. Every delegated child fell through to the SDK's `autoApproveHandler`, however carefully its parent had been wired.

**What that cost, exactly.** A `VerificationGate` *deny* still bit inside a child: denials are threaded into the executor and no later approval releases them. What was lost is the **review** tier — every call the gate left undecided reached the resume handler, and for a child that handler auto-approved. So a host running "ask before acting" had a human review `write` at the top level and never see the same `write` issued one hop down. The shipped CLI encodes the workaround as policy: its sub-agent prompt says *"do not ask the parent questions; make reasonable assumptions"*, because a question had nowhere to go.

`AgentTaskContext.resumeHandler` carries the parent's channel and `AgentManager` stamps it onto the child config — beside the trace parent and the tenant triple, for the same reason: a `configBuilder` is written by whoever registered the agent and cannot be trusted to forward something it was never told about. An explicit `configOverrides.resumeHandler` still wins, so one child can be given a different channel or none. `SupervisorAgent` now puts its own handler on the spawn context; it already gave that handler to its own run and its own coordinator tools, so the two had disagreed — the supervisor paused for a human while the workers it launched approved themselves.

Absent still means auto-approve. A host that never wired a handler is unaffected.

The handler is passed as the function itself, which works because delegation is in-process — `LocalTaskGateway` is the only gateway in the tree. A gateway dispatching across a process boundary could not carry a closure and would have to proxy the request onto the parent's event stream and route the answer back by request id. The upward half of that already exists: `wrapChildListener` stamps lineage on every child event the parent sees, and `user_question_asked` / `tool_review_requested` / `run_paused` are already typed events.
