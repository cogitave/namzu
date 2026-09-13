# Recovery instructions must agree with the host's actual tools

Base: `6a6921c1`, 2026-09-13. [Raw cases](recovery-guidance-results.json).

The preceding [availability experiment](availability-results.md) left a concrete
failure: after deliberately broken automatic query planning, a live small model
used a changed workspace file to answer a historical question. Exact archive
tools worked in controlled Session and terminal tests. This investigation
inspected what actually reached the provider before changing production code.

## Transport evidence

The natural CLI driver now accepts `--inspect-wire`. Its
[observer](observe-recall-wire.mjs) wraps the actual `fetch` boundary for Codex
Responses, preserving the original request, signal, response and transport. It
records only structural facts and fixed substring checks: model, effort,
tool names, description lengths, instruction hash, input type/order/length and
presence of generated identifiers or known guidance. It does not record headers,
cookies, account identifiers, arbitrary request text or opaque reasoning.

The baseline (`hjnsvy`) sent both archive function schemas with automatic tool
choice. System instructions contained conversation recovery guidance and the
historical/current source distinction. But the retained `read` preview also told
the model to use workspace `read`/`grep` to recover the spilled output. The CLI's
system instructions explicitly directed it to scoped archive tools instead.
This contradiction was present on both actual HTTP requests. The model used
workspace grep and returned the new identifiers as the old observation.

The initial observer searched JSON-escaped input and therefore missed the
availability marker. Its baseline `input[].availability` booleans are **not valid
availability measurements**. The SDK boundary independently recorded the note.
The observer was corrected before the candidate to decode strings and Responses
text blocks; a Node test reproduces both forms and verifies private text and
reasoning are not saved. Baseline raw records are preserved, not retroactively
changed. Input character counts also use different representations across these
two probe versions and must not be compared.

## Production correction

The SDK's shortened-output notice now identifies the spill as a retained
observation and defers to host-authorized recovery tools. It does not assume
workspace tools exist or can access internal storage. It distinguishes a new
observation of mutable input from recovery of its earlier contents. If recovery
is unavailable, missing detail remains unknown. No tool is automatically called,
no permission is expanded, and no CLI tool name is added to the SDK.

Retention, integrity manifests, preview bounds, head/tail selection and the
durable spill marker are unchanged. Older recorded preview text is not rewritten.
The SDK test that previously required filesystem recovery instructions now
requires the host route. This fixes a real contradictory contract regardless
of the model outcome; it is not a deterministic historical-intent classifier.

## Live CLI comparison

Both cases use the existing generated 400-line fixture, with two original
identifiers outside the visible preview. The initial model decisions are
scripted, but the real CLI `read` tool and archive execute. After initial
retention is checked, the driver replaces the workspace file with new values.
Every follow-up resumes the same conversation in a fresh real CLI process.

Automatic query planning is deliberately replaced with invalid JSON. Main
requests remain live Codex `gpt-5.6-luna`, low effort, four iterations per turn
and a 120-second process deadline. Historical admission is 30,000 tokens;
current admission is 25,000. These are admission controls, not hard billing caps.
No build ran during either live case.

| Case | Historical follow-up | Current follow-up | Live tokens |
| --- | --- | --- | ---: |
| Before (`hjnsvy`) | **Wrong:** current identifiers after workspace grep | Not run | 17,107 |
| Corrected (`wX1SPG`) | Exact originals after one archive search | Exact replacements after workspace grep | 36,727 |

The corrected historical answer needed no additional archive read: the search
excerpts already contained both exact identifiers. The first historical wire
request contained neither original value; both appeared only after the real
archive search. Its failed-recall status was present in temporary user context,
with no invalid planner text. The new recovery guidance survived in the recorded
preview and the old conflicting guidance was absent. Current-value selection
still worked even though old identifiers remained in conversation history.
Both cases preserved the replacement file and reported no failed tools.

Combined live usage was **53,834 tokens**; initial observations and injected
plans consumed zero live tokens. These are separate generated fixtures with
one run per condition. The observations are encouraging, but do not establish
a causal effect size, accuracy rate, provider equivalence or cost savings.
The previously recorded failing cases remain controls. Other sources of wrong
temporal selection, including natural planning failures, remain open.

Reproduce the candidate with:

```sh
node research/conversation-evidence/natural-cli.mjs --referential --scripted-observation --fail-query-plan --inspect-wire --check-current --live
```

The probe fingerprints the provider adapter and output-budget implementation
alongside the existing recall pipeline. The observer itself is recorded in the
source fingerprint set. These are diagnostics for this isolated fixture,
not a production credential or transcript capture facility.

## Validation

The targeted output-budget and cleared-result recovery suites pass all 47
tests, including hard preview bounds, exact spill bytes, manifest failure and
clearing that preserves the recovery path. Workspace typecheck, lint, build and
all package test commands pass: 6,691 SDK and 2,977 CLI tests, with five existing
CLI skips. Docs conformance, 48 SDK fences and 20 package READMEs pass as well.
The actual CLI experiment above verifies the changed preview after process
restart with live model decisions. No new TUI-specific rendering behavior is
introduced; this run does not claim a new interactive TUI test.
