# Recovering a command receipt without repeating its effect

Verified 2026-09-13 on Linux/WSL. Reproducer:
[interrupted-cli.mjs](interrupted-cli.mjs), with `--effect --torn` and optional
`--live`. Recorded commands, source fingerprints and results:
[shell-effect-results.json](shell-effect-results.json).

## The stronger test found another defect

The [previous interruption experiment](interrupted-results.md) started with a
read-only tool. This one starts a real CLI Session whose scripted provider calls
the production `bash` tool. A synthetic `node record-once.cjs` increments a file
counter and emits a 400-line receipt. It has a non-idempotent effect: repeating
it increments the counter again. The fixture occupies a separate temporary
workspace and does not contact an external service.

Before the fix, the counter was 1, but shell condensation had turned 339,109
characters of captured output into a 1,827-character result. The UUID receipt
was still visible; 397 surrounding rows were gone. No original-output artifact
was retained. The probe failed its retention assertion before attempting
recovery. Its original fingerprint set omitted the executor/budget modules;
this is a verified failure observation, not a controlled performance comparison.

Code inspection confirmed the cause: `ToolExecutor` called `maybeCompress`
before `applyToolOutputBudget`. The latter saw only the condensed result and
therefore neither retained the original nor marked the event as reduced. The
compressor normalizes numbers when detecting similar lines, so the omitted rows
can contain distinct values. Recovering the surviving UUID alone would have
missed this defect.

## Implementation

The SDK passes the permitted original and an optional condensed presentation
separately to its output budget. The original is retained and authenticated
before that extra condensation is used, even below the ordinary size cap.
The condensed view contains the recovery path, and the completion event records
the original length and reduction flag. An unavailable store or failed manifest
falls back to the ordinary bounded original. Post-tool replacement/error hooks
run before retention; their pre-redaction text is not spilled by this path.
Matching rich-content text uses the same bounded preview.

This extends the existing retained-evidence mechanism rather than adding a
second archive. The [prior source comparison](interrupted-results.md#source-comparison-and-implementation)
with Pydantic AI Harness distinguishes recorded tool effects from permission to
resume execution. Here the measured gap was in Namzu's own presentation-to-storage
boundary; no new competitor speed or quality comparison is claimed.

## Actual command and process results

After the real command completed and the next provider request began, the seed
replaced the manifest and the parent killed the seed process. The parent observed
`SIGKILL`, then injected an incomplete JSONL tail as a separate fault. Recovery
ran the production `run --resume` command in a fresh process. Its prompt was:

> What was the ORCHID receipt from the earlier command? Please read and quote the original passage.

It supplies no run ID, retrieval-tool names or instruction forbidding commands.
The persisted chat projection has no random receipt value. It does name the
earlier command. This is a controlled projection fixture, not an automatic
compaction measurement.

| Trial | Recovery calls | Counter before → after | Original exact read | Tokens |
| --- | --- | --- | --- | ---: |
| Scripted recovery after kill + torn tail | search → read | 1 → 1 | Passed | 0 |
| Codex Luna/low after kill + torn tail | search → read | 1 → 1 | Passed | 22,025 |

Both runs verified the full retained output's hash against the original command
text, a read of its originating `tool_completed` event, an unchanged replacement
file, unchanged old metadata/transcript hashes, and unchanged module fingerprints.
Recovery emitted no original command call. The selected read returned 6,000
characters from a 339,109-character original; the requested receipt fits that
page. `complete: false` and a continuation correctly describe the remaining
output. Search remained incomplete because the source run had no terminal status.
Reported I/O was 709,213 bytes for search and 186,345 bytes for read in each trial.

The live limit was six iterations, a 35,000-token admission budget and a
150-second process timeout. Its 22,025 reported tokens were unpriced by the
catalogue; zero priced cost does not establish free usage. These are two bounded
functional checks, not an estimated general success rate or latency benchmark.

## Regression coverage and limits

The CLI Session regression now covers both `read` and a real counter-mutating
`bash` command, subsequent compaction, a new Session, exact full-output pagination,
altered-artifact refusal and foreign ownership. SDK tests cover condensed outputs
below/above the cap, both visible text channels, unchanged image content,
replacement/error hooks, missing retention, failed manifests and hard text caps.

Workspace typecheck, lint, build and tests passed: 6,467 SDK tests and 2,901
CLI tests, with five existing CLI skips. The SDK process suite passed 261 tests.
Docs conformance/fences, project references, exported signature types, and log/external
name gates plus their 52 tests passed. Lint retains 37 SDK and 14 CLI warnings.
Release-only coverage, eval, packaging and registry checks were not run; no push
or publication is claimed.

The experiment does not establish exactly-once execution for a command killed
before its completion record was saved. It also cannot recover bytes discarded
by a subprocess or sandbox before the tool returned. Windows hard-kill behavior
was not exercised. The autonomous-kernel goal remains active.
