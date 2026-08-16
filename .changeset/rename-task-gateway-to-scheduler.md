---
'@namzu/sdk': minor
'@namzu/cli': patch
---

`TaskGateway` becomes `TaskScheduler` and `LocalTaskGateway` becomes
`LocalTaskScheduler`. Old names still work and are marked `@deprecated`;
they go in the next major.

"Gateway" names an object that sits at a system boundary and faces outward
— Fowler's POEAA Gateway, an API gateway, a payment gateway. This one faces
inward: it creates, waits on, continues, cancels and lists in-process agent
tasks. A reader who trusted the name expected a facade over something
external and found a scheduler.

Two config fields move with the types, because the field name is what a
host actually types and leaving one spelled `gateway` would retire the type
while keeping its vocabulary:

- `QueryParams.taskGateway` → `QueryParams.taskScheduler`
- `SupervisorAgentConfig.gateway` → `SupervisorAgentConfig.scheduler`

Both accept either spelling for the window. Setting both to different
instances throws and names both fields; setting both to the same instance
is fine. The supervisor resolves the pair once rather than at each read, so
a host that sets only the new name cannot get a working scheduler on one
path and `undefined` on another.

`SupervisorAgentConfig` with neither a scheduler nor an `agentManager` is
still an error, and the message now names `scheduler`.
