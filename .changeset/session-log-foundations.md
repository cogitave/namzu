---
"@namzu/sdk": minor
---

Every id the SDK mints is now a UUID version 7, and the session → turn → message schema ships beside the run types.

- `generate*Id` factories mint UUIDv7 instead of v4: a millisecond timestamp, then a counter and randomness, so ids sort by creation time as strings and ids from one process sort in the order they were minted. Every id check still accepts versions 1 to 8, so stored v4 ids keep working. Code that parsed the version nibble of a minted id sees `7`.
- New `TurnId` and `RecordId`, with `generateTurnId`, `generateRecordId`, `asTurnId`, `asRecordId`, and `fixtureId.turn` / `fixtureId.record` in `@namzu/sdk/testing`.
- New session-log schema, described in `docs/sdk/session-log.md`: `SessionEvent` (62 event types, `sessionId` on every event, `turnId` inside a turn), `SessionRecord` and `SessionRecordSchema` with `parseSessionRecord`, the `Turn`, `TurnSettlement`, `TurnStatus` and `TurnExecutionStatus` types, `TurnInProgressError` and `isTurnInProgressError`, the `Checkpoint` document with `parseCheckpoint`, and `recordSha256`, `parseSessionLogLine` and `formatSessionLogLine` for one log line.
- New layout helpers for `NAMZU_HOME`: `resolveNamzuHome` and `NamzuHomeError` (moved from the CLI, same behaviour), `SessionPaths`, `ensureProject` (mints a project id once per working directory into `projects/<slug>/project.json`, safe against racing processes), `slugForCwd`, `hashedSlugForCwd` and `tempRoot`.
- New telemetry attribute keys `NAMZU.TURN_ID`, `NAMZU.TURN_STATUS`, `NAMZU.SESSION_PARENT_ID` and `GENAI.CONVERSATION_ID`. Nothing emits them yet; the run keys are unchanged.

Nothing existing changes behaviour except the id version: queries, stores and the on-disk run layout are as before.
