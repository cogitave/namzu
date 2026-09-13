# Public transcript restoration on resume

Recorded 2026-09-13 against `43124f06` plus this change.
[Machine-readable observations](resume-projection-results.json).

The previous missing-subject TUI inspection exposed empty assistant gutters.
`projectConversation` emitted a row for every assistant message, even a null
body carrying only a tool call. It also ignored retained public `textParts`,
so a streamed explanation could disappear from the reopened transcript even
while its native provider item remained in model history.

The CLI now derives display text from valid public parts when their selected
answer equals the current message content. Otherwise it uses current content.
Whitespace-only items create no row. Original nonempty text is not trimmed or
deduplicated. This same projection serves startup resume, `/resume`, and the
saved prefix of an earlier-prompt fork. Model history is a separate value and
is not rewritten by display projection.

## Verification

- Projection controls cover tool-only bodies, whitespace, exact nonempty bytes,
  repeated final items, mismatched content and malformed optional metadata.
- An Ink App integration seeds the real SQLite conversation store, reopens it,
  checks separate progress/final entries and absence of empty gutters/private
  reasoning fields, submits a continuation, and compares its exact original
  history both at Session input and after durable publication.
- The existing native Session regression checks tool continuation, persistence,
  process-independent Session reopen and provider-route isolation. Existing
  resume/fork race controls still pass. The focused set contains 33 tests.
- Two actual 80-column terminal processes reopened the existing phase and
  missing-SIGMA fixtures. Both accepted input and exited through `/exit` with
  code zero. The phase continuation request preserved the original three public
  native items and exact tool output; the fixture answered `RESUMED` without a
  new tool call. The recall fixture again checked SIGMA focus and absence of
  unrelated record codes in automatic context before answering.
- ANSI terminal recordings were replayed with the installed `@xterm/headless`
  terminal parser to inspect screen/scrollback rather than count raw redraw
  strings. The new phase and recall screens contained no empty assistant rows.
  Equal commentary and final `Which record?` items remained two public entries.

These two terminal continuations used offline provider transport fixtures,
not live model inference; they consumed no vendor tokens. They test Namzu's
actual CLI, persistence and request conversion, not model quality. Local
artifact paths and code fingerprints are in the JSON observation record.
The earlier live small-model results remain in
[query focus observations](query-focus-results.md); they were not rerun for
this display-only change.

To recreate the phase fixture, run `node research/conversation-evidence/text-phases-cli.mjs`.
Its printed result supplies the isolated home, workspace, preload and CLI paths.
From that workspace, launch Node with the printed `--import` preload and CLI
path, `NAMZU_HOME` set to the isolated home, and
`NAMZU_VERIFY_PHASE_REPLAY=1`; pass `resume` and the generated conversation UUID.
Send a continuation as text and Enter in separate inputs, then `/exit`.

Workspace typecheck, lint, build and all package tests passed, including 6,646
SDK tests, 2,945 CLI tests (five skipped) and 123 OpenAI driver tests. Lint
retains existing warnings. Documentation conformance and compiled fences,
exported signature types, SDK test presence and publish metadata also passed. These results do
not claim all release gates or a package publication.

## Limits

Historical tool cards are still not rebuilt by this text projection. Tool
calls/results and provider replay data remain available to the model and the
existing conversation evidence tools. Late-only phase metadata still cannot
retroactively split an already streamed untagged live bubble. Evidence search
still indexes selected content, and the absent-subject follow-up still needs
work on redundant explicit searches. An assistant statement recalled from
history is not an independent observation or proof that a record is absent.
