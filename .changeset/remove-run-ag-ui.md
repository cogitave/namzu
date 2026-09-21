---
"@namzu/ag-ui": major
---

Requires `@namzu/sdk >=44.0.0` (was `>=36.0.0`), where the kernel's run became
a turn inside a session. Earlier `@namzu/ag-ui` versions break against SDK 44.

**What changes on the wire.** The AG-UI ids themselves do not: `RUN_*`
events still echo the client's `threadId` and `runId` verbatim. Only the
Namzu-owned names change.

- Error codes on `RUN_ERROR`: `NAMZU_RUN_ERROR`, `NAMZU_RUN_CANCELED` and
  `NAMZU_RUN_PAUSED` are `NAMZU_TURN_ERROR`, `NAMZU_TURN_CANCELED` and
  `NAMZU_TURN_PAUSED`.
- New `NAMZU_TURN_IN_PROGRESS`: a second run on a thread whose Namzu session
  already has an active turn is answered with `RUN_ERROR` carrying this code
  instead of starting a parallel one.
- The pause custom event `namzu.run.paused` is `namzu.turn.paused`.

**What changes for a host.** A thread maps to a Namzu session and each AG-UI
run to a new turn in it. The client's `runId` is recorded as the turn's
`origin.externalTurnId`, never used as a Namzu id. `MESSAGES_SNAPSHOT` is the
session's folded transcript, so it shows the answer after any guardrail or
review rewrite, never the raw text.

**What to do.** Upgrade `@namzu/sdk` and `@namzu/ag-ui` together, and rename
any client code that matched the old error codes or custom event name.
