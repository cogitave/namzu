# Advisory request snapshots

2026-09-13. Built SDK execution and a separate actual TUI recall check. This
is not an autonomous-task benchmark and does not enable a default CLI advisor.

## Verified defect and implementation

Before this change, answer review could capture request-only evidence, but
advisory consultations received canonical history alone. The preceding
`40651dd9` projection fix preserved rich text already in that history; it could
not recover text never placed there.

The same successful-dispatch snapshot now serves configured advisors. The
runtime joins it to records starting at the exact current response object,
only within that iteration. A single serialized window labels request records
and subsequent records separately. No duplicate canonical transcript is added.
Without a valid current response anchor it falls back to labelled canonical
history. The snapshot is cleared in iteration cleanup and is not checkpointed.
Image recovery uses the successful repaired request, not the rejected payload.

This is a trajectory of what was dispatched and later appended. It does not
claim to project all later edits to earlier canonical records, or current disk
state. Same-batch tool results not yet committed to history are not invented.

## Actual SDK transition probe

Run `node research/conversation-evidence/advisory-history-smoke.mjs --transition`
for a scripted transport control; add `--live` for one real Luna low advisor.
The probe reads an isolated receipt in preparation and puts its value only in
request context. The one real tool action replaces the file and returns its
new value. Main-model turns are scripted; the live advisor is not.

Both executions completed with `end_turn`. Each performed one tool write and
one tool read, with two read-only preparation observations across the two main
turns. The original value appeared in request-stage context; the changed value
appeared in the subsequent tool result. The live advisor named both exact
identifiers, rejected the separate `CLAIM-ONLY` guess as neither observation,
and noted that image pixels were omitted. Its 798 reported tokens comprise
633 input and 165 output tokens; none were reported cached.

Each run was capped at 3,000 tokens, three iterations, 30 seconds and one
advisor call with a 256-output-token ceiling. The tool action was not replayed.
The fixture file matched its expected changed contents, request context did
not enter durable messages, advice reached the next main request, and the
fingerprinted build files did not change during either execution. Machine
records are in `advisory-turn-results.json`.

This is one live judgment over a controlled transition. It does not establish
an accuracy rate, a cost saving or the quality of an autonomous main agent.

## Actual interactive resume check

The built CLI was started in a 100-column, 28-row PTY with the existing
`record-origin-tui-fixture.mjs` transport assertions. It resumed synthetic
conversation `d76f9226-332f-46ef-a082-3fdab6a12d98`, received a new ORCHID-history
question, returned to an idle composer and exited through `/exit` with code 0.
The actual request contained four bounded whole-part records, including a tool
observation and assistant claims with separate producer kinds. The response
text was scripted after those assertions; no vendor inference occurred.

The ANSI recording was replayed through installed `@xterm/headless` at the
same dimensions. Its final frame retains the previous conversation and the
new exchange once each, followed by the idle composer. The frame and trace
are recorded alongside the SDK probe results. This checks the existing TUI
recall path, not an interactive advisory feature that the CLI does not enable.

## Checks and primary-source comparison

The focused 128 checks cover staged windows, both consultation paths,
subsequent input, driver mutation, image repair, checkpoint resume, cancellation,
answer review and the existing advisory budget/accounting behavior. Full
workspace tests passed: SDK 6,676; CLI 2,951 with five skipped. Typecheck, lint,
documentation conformance, compiled fences, exported signature types,
test presence and publish metadata passed. Existing lint warnings remain.
These are local checks, not a claim that a release was published.

The [Pydantic AI Harness trajectory judge source](https://raw.githubusercontent.com/pydantic/pydantic-ai-harness/main/pydantic_ai_harness/trajectory_judge/_capability.py)
captures a request trajectory before starting evaluation. That is the relevant
comparison: review what was actually available, with explicit attribution and
lifetime. Namzu reuses its existing synchronous advisory mechanism and shared
accounting; this patch does not copy concurrent scheduling or durable workflow
behavior from that implementation.
