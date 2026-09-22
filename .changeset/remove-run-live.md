---
"@namzu/live": major
---

Requires `@namzu/sdk >=44.0.0` (was `>=34.0.0`). The SDK's run became a turn
inside a session, and the ids `@namzu/live` reports from the model changed with
it. Earlier `@namzu/live` versions break against SDK 44.

- `LiveModelEvent`: the `usage`, `completed` and `cancelled` events carry
  `sessionId` and `turnId` (the model's own session and turn — for
  `NamzuModel`, the SDK session and turn the query ran as) instead of `runId`.
- `LiveSessionEvent`: the `usage` and `turn_completed` events carry
  `modelSessionId` and `modelTurnId` instead of `runId`. Their `turnId` is
  still the live session's own turn.
- `LiveTurnResult.runId` is replaced by `modelSessionId` and `modelTurnId`.
- `LiveErrorCode` loses `'run_not_speakable'` and gains
  `'turn_not_speakable'`: the error `NamzuModel` raises when the SDK turn did
  not complete with a stop reason it can speak. A caller that switches on `err.code`
  must match the new value.

`NamzuModel` maps the SDK turn's `result`, `status`, `tokenUsage` and
`stopReason` exactly as before. A `createQueryParams` callback passes
`turnConfig` instead of `runConfig`, and an `InMemorySessionLog` as
`sessionLog` where it used to pass an `InMemoryRunStore` as `runStore`.

What to do: rename `runId` reads to `modelTurnId` (and `modelSessionId` where
you need the session), match `'turn_not_speakable'` where you matched
`'run_not_speakable'`, and update the query params your callback builds.
