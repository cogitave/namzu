# Literal retrieval survives an optional query-planning failure

2026-09-13. Base: `3c6ef944`. [Measurements](query-fallback-results.json).

## Dependency and change

An invalid response from optional query planning previously stopped automatic
retrieval altogether. The main request received availability status and could
still use explicit tools, but ordinary current-query tokens were never searched.
The first eight regressions produced six failures and two passing controls on
the base. This is an avoidable dependency on interpretation, not invalidation of
the unchanged operator query or a broken archive reader.

The SDK now reserves room for a fixed planning-failure note, then searches only
the original query tokens through the existing retrieval callback. It uses no
term, focus or reference from the rejected plan. The same 24-candidate, 8 MiB,
retrieval-deadline and context limits apply; status consumes part of the existing
character allowance. Insufficient room skips retrieval. The query loop receives
the failed-stage diagnostic and only fully validated fallback context through
its existing internal error bridge. Ordinary exceptions cannot supply context.
Direct callback consumers still receive the planning rejection.

Empty fallback scans retain their coverage metadata. Read failures, invalid
scope and cancellation never expose partially validated candidates. A rejected
plan remains cached for that operator input, while each following step performs
fresh source validation. A valid ambiguous/none plan keeps its existing behavior.
This is not a heuristic that substitutes the previous topic when search is empty.

The inspected reference is Pydantic AI harness's
[conversation-search toolset at c897c4e](https://raw.githubusercontent.com/pydantic/pydantic-ai-harness/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py).
Its explicit search ranks a supplied query over persisted messages independently
of an extra query-planning inference. Separating retrieval from optional query
interpretation is relevant here; Namzu's bounded automatic fallback and diagnostic
bridge are local changes, not features or results attributed to that repository.

## Real CLI comparison

Both generated fixtures use the [natural CLI driver](natural-cli.mjs):

```sh
node research/conversation-evidence/natural-cli.mjs --live --referential --scripted-observation --distractor-turns 18 --compact-before-recall --fail-query-plan
```

Add `--check-current` for the candidate's present-state follow-up. Initial and
intervening model decisions are scripted, but they execute actual CLI file tools
and persistence in separate processes. The first oversized read retains two
random identifiers beyond its visible preview. The workspace file is then
replaced with different identifiers. Eighteen unrelated read turns follow.
Actual `Session.compact` reduces 76 visible messages to nine, archives the 67
removed messages, and leaves neither original identifier in the projection.

The live follow-up asks:

> En başta incelediğin DELTA kaydının iki kimliğini aynen yazar mısın?

Only the preparation response is replaced with invalid JSON. Main inference is
live Codex `gpt-5.6-luna`, low effort, with four iterations, a 30,000-token
admission allowance and a 120-second process deadline. This is deliberate
planning fault injection, not a measurement of naturally occurring failures.

| Case | First main request | Historical answer | Answer-time tools | Live tokens |
| --- | --- | --- | --- | ---: |
| Base (`YFgeHc`) | Failure note, neither original in automatic context | Both originals correct | One `search_conversation` | 18,084 |
| Candidate (`sUPusQ`) | Failure note and both originals in 4,448 characters of temporary context; neither in ordinary history | Both originals correct | None | 9,515 |

The candidate then receives “Şimdi aynı dosyadaki güncel iki kimliği söyle.”
Planning is also deliberately failed for that turn. The main model performs one
fresh `read` and correctly returns both replacement identifiers, without using
the old values as the answer. That turn uses 18,192 live tokens under a separate
25,000-token admission allowance. Neither run changes the replacement file or
the original output artifact/manifest. All measured production fingerprints
remain stable during the experiments.

Total live usage is **45,791 unpriced subscription tokens**. The baseline already
answered correctly. The candidate removed a model tool round trip in this pair;
different generated fixtures and single samples do not establish a general cost
saving or accuracy rate. An admission allowance is not a hard billing ceiling.

## Real TUI and checks

The [summary TUI fixture](summary-recall-tui-fixture.mjs) adds
`NAMZU_SUMMARY_TUI_FAIL_PLAN=1`. It restores only the base fixture's nine-message
pre-question projection, keeping archives intact, then resumes in a real 100×28
PTY. The same historical question is entered through the composer. Inference is
controlled: one invalid planning response followed by a main request that must
contain both originals solely in temporary context and identify literal fallback.
No answer-time tool is scripted or invoked.

Replaying the capture through `@xterm/headless` shows each original identifier
once, one response and an idle composer. The invalid-plan sentinel is absent
from main input and terminal output. Artifact/manifest hashes remain unchanged;
the workspace still has its replacement values. `/exit` returns zero. This is
a zero-live-token resume, context-delivery and rendering check, not another
model accuracy trial. It does not exercise the `/compact` keyboard command.

Nine new SDK tests cover literal-token isolation, cached failures with fresh
reads, empty/partial coverage, continuation, foreign ownership, failed reads,
cancellation and context accounting. Query-loop tests confirm prior stage
decisions and operator input survive, context remains temporary, and rejected
plan/error text does not reach the main model. The reopened CLI Session test now
covers both explicit archive recovery and direct use of validated fallback.

Focused SDK tests: 117 passed. CLI Session tests: 37 passed. Full workspace
typecheck, build, lint and package tests pass: **6,705 SDK tests**, **3,018 CLI
tests**, with five existing CLI skips. Lint retains warnings without errors.
Docs conformance, compiled fences, test presence and signature exports pass.
During implementation TypeScript caught a missing user-role guard in the new
Session test; it was corrected before the candidate live/TUI runs. No product
behavior was changed to accommodate that test error. No publish or complete
release-gate run is claimed.

Literal fallback does not resolve unnamed references, infer temporal intent,
guarantee relevant candidate discovery, or prove a source claim. It can return
irrelevant lexical matches under its existing bounds. The note states those
limits and leaves explicit tools available. The broader goal remains active.
