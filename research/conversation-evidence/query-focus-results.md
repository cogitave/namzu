# Keeping the requested subject in evidence discovery

Experiment base: `2a1e0e5c`, 2026-09-13.
[Raw live observations](query-focus-results.json).

## Source evidence and design

The [prior missing-SIGMA trial](reference-context-results.md) supplied DELTA and
OMEGA passages even though the operator explicitly requested SIGMA. The planner
returned a direct query and the host's disjunctive word search matched common
field vocabulary. It eventually withheld a value, after two explicit searches.
The old code did not distinguish a subject word from the field being requested.

[QuReTeC](https://arxiv.org/abs/2005.11723v1) treats conversational query resolution
as selection of existing history terms. Its
[pinned query generation code](https://github.com/nickvosk/sigir2020-query-resolution/blob/da876054ea7dd97beeb84a4a941f2e69a1ba024b/generate_query_files_for_trained_model.py)
uses predicted labels to select source terms. Namzu already uses source word IDs;
the new step also selects a bounded subset for subject-focused discovery.

[CRAG](https://arxiv.org/abs/2401.15884) separates retrieval evaluation from answer
generation. Its [internal preparation code](https://github.com/HuskyInSalt/CRAG/blob/main/scripts/internal_knowledge_preparation.py)
selects relevant passage strips using a trained evaluator. That separation is a
useful design reference, but Namzu does not reproduce CRAG's evaluator, confidence
thresholds, web expansion or benchmark. Here the selection is exact lexical
focus from an existing bounded query-planning call, with explicit uncertainty.
These primary sources and their code were inspected before implementation.

## Declared checks

1. An explicitly named absent subject must not inject other records merely
   because their field names match. Empty focus metadata must not claim absence.
2. Known subjects must still recover exact original values after process restart
   and external source replacement. Topic return must not choose the newest topic.
3. Scope, preview status, continuation, cancellation and context limits must
   survive focus. Explicit broader archive queries must remain available.

Unit checks control planner output. CLI integration retains compaction archives,
reopens the session store, checks missing and present subjects, and runs a broader
explicit search afterwards. These establish mechanics, not model selection skill.
The bounded live checks use the existing reference-context process driver, with
one missing-subject sample and one known-subject/topic-return sample, Luna low,
four iterations, 25,000-token admission per case and 120-second deadlines. Seeds
are scripted, source tools and persistence are real, follow-up processes use the
live provider. Admission allowances are not guaranteed billing ceilings.

The initial multi-focus test exposed a callback-argument bug: passing the token
key function directly to `map` passed the element index into its case-sensitivity
argument. The second focus word stopped matching case-insensitively. Explicit
one-argument callbacks corrected it before any live experiment.

## Observations

| Case | Temporary context | Final answer / tools | Live tokens |
| --- | --- | --- | ---: |
| Missing SIGMA (`X17QgF`) | Focus `SIGMA`, zero matched focus terms, neither other original code injected | Withheld the code; searched `SIGMA`, then `takip kodu` explicitly | 27,438 |
| Topic return (`pG1FNn`) | Focus `DELTA`; original DELTA code only, not OMEGA or current replacement values | Returned exact original DELTA; no tools | 11,551 |

Both follow-ups reopened seeded conversations in new real CLI processes and
left externally replaced source files unchanged. Every recorded build fingerprint
was stable during its run. Missing-subject planning selected source word IDs
`[3,7,8]`, focus `[3]`; topic return selected `[28,6,7]`, focus `[28]`, with an
exact quote of the first DELTA request. Neither planner invented a subject.

The missing run used 901 planning tokens plus 26,537 over three main requests;
7,168 tokens were cache reads. The known-subject run used 1,193 planning tokens
and 10,358 for one answer request, with no cache reads. Total live usage was
38,989 tokens. The missing run exceeded its 25,000 admission value: a request
admitted with remaining allowance can finish beyond it. No hard billing-cap
claim is made.

The prior missing trial used 28,250 tokens and also made two explicit searches.
The new sample removes unrelated automatic passages but does **not** establish
fewer verification calls or a general cost reduction. Its second broad explicit
search can still retrieve other records; the final answer did not substitute
their values. The archive tools intentionally remain accessible.

An additional local hardening after the live runs copies terms before handing
them to a JavaScript retriever. A mutating host cannot alter cached focus or its
diagnostic for the next preparation step. This boundary was tested separately;
no repeat live model run is claimed for that defensive copy.

## Terminal and verification

The missing conversation was also reopened in a real 80-column TUI using the
[offline assertion fixture](query-focus-tui-fixture.mjs). Sending another explicit
SIGMA question ran the planner and automatic recall through the interactive
session. The provider fixture verified the focused temporary context and absence
of unrelated synthetic identifiers before emitting its test acknowledgement.
The composer returned idle and `/exit` exited successfully. This used zero live
tokens and tests host wiring, not a model's reasoning or TUI aesthetics. The
trace is included in the observation JSON. Resume also showed empty assistant
markers for earlier tool-only messages; that presentation defect was open at
the end of this experiment. The subsequent [resume projection check](resume-projection-results.md)
records its fix, including actual TUI continuation and native replay controls.

Workspace typecheck, build, lint and package tests passed, including 6,645 SDK
tests and 2,935 CLI tests (five skipped). After the defensive copy, typecheck
and 103 focused SDK tests passed, including the additional mutation test.
The CLI archived/reopened-session suite passed all 58 tests. Docs conformance,
compiled fences, signature exports, SDK test presence and package publish
metadata checks passed. No push, publication or complete release-gate run is
claimed.

This is two controlled samples, not a retrieval benchmark. Focus can still be
wrong or omit a passage whose subject is outside the returned excerpt. A future
evaluation should vary aliases, multi-word subjects, cross-paragraph values and
unsupported absence assertions before making broader precision/recall claims.
