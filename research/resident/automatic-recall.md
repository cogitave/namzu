# Automatic original-evidence recall across resident admissions

Started 2026-09-13 at `ce27604e`. This milestone is active. The existing explicit
resident evidence tools work, but automatic resident preparation is not yet
implemented or live-verified here.

## Composition and reference inspection

`integrations/resident/session-step.ts` creates a fresh Session for each admitted
pursuit step. It mounts settled history and tool-evidence sources, supplies the
current objective, saved summary and ordered wake inputs, and holds normal tool
permissions. It does not supply `conversationSessions`. The ordinary automatic
recall hook in `tui/agent.ts` consequently returns no preparation step for these
admissions. Giving it arbitrary old Session IDs would be a scope change, not the
right adapter.

SDK `createResidentToolEvidenceSource` already verifies a settled claim through
adjacent agenda revisions before asking the host to resolve its invocation.
The source captures tenant, resident, pursuit and upper revision; CLI resolution
also validates attempt receipts and the run's project/Session ownership. This
is the retained substrate to reuse, without another mutable history store.

Inspected the local Pydantic AI Harness checkout at
[`c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504`](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py#L353).
Its toolset filters runs by conversation, loads each selected run's history,
ranks untruncated message text with BM25, then renders bounded display windows.
The inspected method separates discoverable text from what is displayed. Its
result-count limit is not a total-byte limit over those history loads. This is
a description of that pinned method, not every backend or current upstream.

## Read-budget prerequisite

The current resident wrapper permits separate 8 MiB history and run-source
operations, plus host attempt resolution. Merely calling it several times from
the existing 8 MiB automatic-recall callback would not enforce that callback's
aggregate contract. The composition needs an explicit allowance across history,
attempt resolution and evidence reads, including failure accounting. Matching
returned byte counts cannot prove that arbitrary host code honored its limit.

The first change adds per-call allowances to the existing low-level readers:

- Resident history search/read: 1 byte–8 MiB, default unchanged.
- Disk tool/text and captured live text search/read: 1–8 MiB, bounded by the
  source's existing configured ceiling. The live final ownership check remains
  inside the effective allowance.
- An allowance is not source/query identity. A returned continuation can be
  retried with another allowance, including after reopening, without losing the
  original scope. Failed exact reads do not return invented byte receipts.

Four added regressions failed against the base (68 existing cases passed).
After implementation all 72 tests in those three files pass. Real disk fixtures
exercise a large inline record that fits the source ceiling but not the current
call's allowance, continuation after reopening, refusal to raise a source ceiling,
exact read failure/recovery and live ownership changes. History tests verify that
a budget stop retains the unvisited settlement instead of marking it missing.

This foundation is not the complete resident adapter. The adapter still needs
combined history/resolution/evidence accounting, query selection from the actual
admitted state, preservation of historical Session/claim addresses in shared SDK
ranking, cancellation, request-only context and real resident CLI measurement.
Explicit tools must remain available for incomplete selection. No ordinary-chat
scope broadening, action replay, new history store or default resident inference
is part of this first change.

Foundation verification: workspace typecheck, build, lint and all package tests
passed (6,709 SDK tests; 3,018 CLI tests and five existing skips). Documentation
conformance/fences, signature exports, test presence and project references also
passed. Lint retains existing warnings. These are development checks, not a
complete release-gate run; no publication or live-model recall claim is made.
