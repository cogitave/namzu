# A declined call survives a reload

Before: after reopening a conversation, a call the person declined (Reject, or Edit with a note) read "details unavailable", because the runtime recorded no presentation for a refused call and could not tell a person's No from a policy refusal.

## What was done

- The review answer now carries a structured marker, `declined?: { note? }`, set only by a host that is reporting a person's No (Desktop does, through ACP). It travels `ToolReviewAnswer` / `AcpPermissionOutcome` -> `reject_tools.declined` (and a per-call `modify_tools` deny) -> `ToolExecutor.executeBatch(..., declines)` -> `recordDenial`.
- `recordDenial` records, for a declined call only, a generic result view `{ label: <call target>, declined: { note? } }` (note capped at 4,000 characters). Every other refusal keeps its recorded shape: an error result, no presentation key (pinned in `a-persons-no-is-recorded-as-theirs.test.ts`).
- Desktop sends the typed note apart from the model-facing wrapper, so no text is parsed anywhere.
- The CLI host's history mapping and Desktop's history restore admit the new field (closed shape, note bounded, only on a failed call).
- Desktop row: new state `declined`, "Declined edit to app.css", "Declined command", status "Declined", "You said: ..." when opened; a run of them folds to "Declined 2 actions"; no click-to-open for a change that never happened.

## SemVer

sdk minor, cli minor: new optional fields only. A bare `reject` over ACP and every policy refusal are recorded exactly as before.

## Verification

- `desktop-history-declined.test.ts` (cli): a real kernel turn with the review answered "declined, with a note", then `namzu/conversations/history` through the desktop host: the mapped tool is `failed` with `presentation { label: '/repo/src/app.css', declined: { note } }`, `partial: false`. The policy-refusal twin maps to `detailUnavailable`, exactly as before.
- SDK: executor, review policy, ACP wire, a whole `drainQuery` turn, and the out-of-band resume path (`resume-pending.test.ts`).
- Desktop: row presentation, history restore (a declined view on a completed call is dropped), permission protocol, run summary.
- Screenshots (preview `/preview?activity=1`, last turn "Switch the accent colour..."): `declined-light-closed.png`, `declined-light-open.png`, `declined-dark-closed.png`, `declined-dark-open.png`.

## Not done

- The terminal UI does not set `declined` yet, so a call declined there still reloads as "details unavailable".
- The real Desktop -> ACP wire is covered in two halves (operator test and ACP server test), not as one process-level run.
