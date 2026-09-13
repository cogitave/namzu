# Historical evidence in ordinary CLI follow-ups

Base: `f1cd16e8`, 2026-09-13. [Raw reports and terminal trace](default-recall-results.json).

## Finding and change

Recorded CLI conversations shortened retained overflow tool text to 4,000 preview
characters by default, but did not install automatic evidence recall unless
`compaction.recallEvidence: true` was supplied. Exact archive tools were already
available. In the natural default-config control below, the model answered a
past-observation question with values from a newly replaced workspace file.
The opt-in control recovered the original values using the existing SDK step.

Recorded CLI sessions now install that same bounded step when the setting is
omitted. Explicit `false` disables both automatic retrieval and its query planner;
`resolveEvidenceQueries: false` keeps local literal retrieval without preparation
inference. Stateless conversations and SDK host opt-in are unchanged. This is a
CLI **major** default change because it can add inference usage and latency.

The current Pydantic AI harness
[conversation-search capability](https://raw.githubusercontent.com/pydantic/pydantic-ai-harness/main/pydantic_ai_harness/conversation_search/_capability.py)
and [toolset](https://raw.githubusercontent.com/pydantic/pydantic-ai-harness/main/pydantic_ai_harness/conversation_search/_toolset.py)
were inspected as primary implementation references. Their scoped historical
lookup and lazy retrieval support keeping recoverable history outside the active
prompt. They do not establish Namzu's automatic query-resolution behavior or
accuracy. The default change follows the local observed failure, not a claimed
benchmark equivalence with that implementation.

## Declared scenario and controls

The [natural CLI driver](natural-cli.mjs) runs an isolated conversation through
separate real `run-stream` processes. A scripted first decision reads a generated
400-line file through the production file tool and records a brief summary. Two
random original identifiers lie beyond the visible preview. The driver verifies
successful retention, zero original identifiers in the initial visible tool or
assistant text, normal completion and unchanged original source. It then replaces
the workspace file with two different identifiers.

Live follow-ups use Codex `gpt-5.6-luna`, low effort:

1. `Az önce baktığın kaydın iki kimliğini aynen yazar mısın?`
2. `Şimdi aynı dosyadaki güncel iki kimliği söyle.`

Each live turn allows at most four iterations and 120 seconds. Historical and
current admission budgets are 30,000 and 25,000 tokens respectively; these are
admission limits, not guaranteed billing caps. Web search and project-memory
recall are disabled. No provider request is scripted after the first observation.
All three cases retain stable built-module fingerprints throughout execution.

## Observations

| Case | Historical question | Current question | Total live tokens | Preparation tokens included |
| --- | --- | --- | ---: | ---: |
| Previous default (`td69z6`) | **Wrong:** current replacements after a workspace grep | Exact replacements after a workspace grep | 34,278 | 0 |
| Previous explicit opt-in (`wvitCy`) | Exact originals; no tools | Exact replacements after a workspace grep | 29,570 | 2,313 |
| New default (`rbUWhw`) | Exact originals; no tools | Exact replacements after a workspace grep | 29,458 | 2,305 |

All three processes preserved the externally replaced file. None reported failed
tools. The failed old-default answer is retained in the raw report. New-default
requests contained both originals in temporary recall context, not ordinary
history, on the historical question. Current-question history naturally contains
the preceding answer's originals, but the final answer still selected the new
workspace observation. No archived state-changing action was replayed.

The combined live usage is **93,306 tokens**; the scripted seeds used zero live
tokens. These are subscription usage observations without dollar pricing. There
is one independent random fixture per case, not a statistical accuracy or cost
comparison. The lower observed new-default total does not establish general
savings: query planning can add cost even where ordinary visible history would
suffice. A model interpretation can still fail or choose the wrong source.

The driver's new `recallConfiguration` field distinguishes omitted defaults from
explicit enabled/disabled settings. Older raw reports retain their original
`recallEvidence` flag; `false` there means the old driver omitted configuration.
Use `--disable-recall` for an explicit opt-out control on current code.

Reproduce the new default live case with:

```sh
node research/conversation-evidence/natural-cli.mjs --referential --scripted-observation --check-current --live
```

## Terminal and regression checks

The [offline TUI assertion fixture](default-recall-tui-fixture.mjs) seeds scoped
original tool evidence and a visible conversation without its values, plus a
different current workspace file. Its config omits all compaction settings.
A real 100×28 terminal resumed the conversation and accepted both follow-ups.
The controlled provider asserts that the historical answer's values occur only
in temporary context; the current answer follows an actual `read` call. Archive
and workspace hashes remain unchanged. This is a wiring and display control,
not a second live model reasoning trial.

The captured terminal, replayed through `@xterm/headless`, shows one historical
answer, one current-file read and one current answer, followed by an idle
composer. `/exit` returned zero. The raw trace includes both preparation calls
and all three main requests. No private project files or credentials enter the
fixture; all identifiers and file contents are generated locally.

The new omitted-config tests initially failed on the old implementation (three
failures). After the default change, existing explicit-archive controls consumed
their scripted provider replies during the newly enabled planning call. Those
four controls now explicitly disable automatic recall, preserving their original
manual-compaction, exact recovery, integrity and foreign-ownership assertions.
Dedicated default tests verify actual automatic recall, opt-out, query-planning
opt-out and reference resolution after eight progress updates.

The focused Session suite passes all 34 cases; the complete CLI suite passes
2,976 tests with five existing skips. Workspace typecheck, lint, build and all
package test commands pass, including 6,684 SDK tests. Docs conformance and
compiled fences pass (48 SDK fences and 20 package READMEs).

The natural driver's offline provider now recognizes preparation requests
without consuming its explicit-tool sequence. Its default-config offline
control also passes: one historical search, one exact archive read and one
current-file read, with real tools and storage and zero live tokens. This checks
fixture reproducibility after the host default change; it does not add another
live reasoning sample.

Invalid or late query plans still follow the existing optional
preparation diagnostic and skip policy. This change does not claim exhaustive
archive discovery, infallible interpretation or complete autonomous cognition.
