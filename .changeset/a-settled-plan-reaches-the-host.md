---
'@namzu/sdk': major
---

A plan that settles says so on the run stream, and the host callback can be heard.

The plan events stopped one short of the outcome. `plan_ready`, `plan_approved`,
`plan_rejected` and `plan_step_updated` all reached the wire; `plan.completed`
and `plan.failed` were folded into a bare `break` in the translator and emitted
nothing. So a host watching the stream saw the steps report and then silence —
it could learn a plan had been approved and never that it closed, which leaves a
plan rendered as in-flight indefinitely.

`RunEvent` gains `plan_completed` and `plan_failed`, and `StreamEventType` gains
`plan.completed` and `plan.failed` for the SSE bridge.

**`failPlan` stops discarding its argument.** The parameter was spelled `_error`
because nothing read it, so a failed plan carried no account of what went wrong
— and an event that says "failed" without saying why puts the reader back where
the missing event did. `Plan` gains `failureReason`, and `plan_failed` carries
it.

**`onContextCreated` now fires where it can be heard.** It ran before the event
translator was wired, so a host that built its plan in that callback — which is
what the callback is for — did it into silence: `plan_ready`, `plan_approved`
and every `plan_step_updated` from inside it were emitted with nothing
subscribed. It now runs after the wiring *and* after `runMgr.init()`; moving it
only as far as the wiring traded a silent drop for a store that was not yet
initialised. It is still called before the iteration loop, which is the
guarantee the callback actually makes.

**How this was found is the part worth repeating.** It came out of the first
live end-to-end run, not from a test. The settlement tests read the outcome off
`PlanManager` through `onContextCreated`, so they proved the plan settled
without ever asking whether a consumer of the event stream could see it — a
verification that was entirely sound about something other than what needed
knowing.

**Breaking:** `RunEvent` and `StreamEventType` are wider. A consumer that
switches exhaustively over either — which the SDK's own A2A mapper, SSE mapper
and run reporter all do, and which is why the compiler named all three — needs
arms for the new members.
