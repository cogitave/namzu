---
'@namzu/sdk': minor
---

The A2A bridge reads a peer's card, and dispatches to it as a delegate.

The bridge was a one-way door: this kernel served an agent card and answered `message/send`, and could read nobody else's. So the delegate seam had no driven consumer — and a seam with no caller is an untested guess at what a caller needs.

New: `fetchAgentCard` and `A2ADelegate`. Register the delegate with `DelegatingTaskScheduler` and a remote peer becomes reachable through the delegation tools with nothing above learning the difference — the last tests assert exactly that, a peer's answer reaching `taskSucceeded` / `taskFailed` correctly through the scheduler.

Refusals happen at wiring time, which is the only moment a human is looking: a card that does not parse, a card offering no interface, a peer with no `jsonrpc` interface, and a protocol version this kernel does not implement. The version comparison is on major.minor — A2A is pre-1.0, where the minor carries breaking changes, so matching the full string would refuse a peer over a patch bump.

Two client-side subtleties the server half does not have. `input-required` stops the poll: it is not terminal for a *server*, which can receive the input and carry on, but it is terminal for a client with no channel to supply it — polling it is polling a state that cannot change. And a cancel reaches the peer as `tasks/cancel` rather than only aborting our own loop, because aborting the poll leaves the peer working, billed, and holding whatever the task holds.
