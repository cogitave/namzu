# Resolving an earlier subject after compaction and restart

2026-09-13. Base: `281859ff`. [Recorded observations](long-history-results.json).

## Reproduced failure

A live CLI follow-up asked, `En başta incelediğin kaydın iki kimliğini aynen
yazar mısın?` after 18 intervening turns, real compaction and a process restart.
The initial subject was DELTA. The planner saw only the two most recent
unrelated inspections, control 16 and 17, and incorrectly selected control 16.
It did not see the compaction summary that still named DELTA, although the main
model received that summary. The resolver excluded all system-role messages.

The main model subsequently made three archive searches without following the
available cursor. One original identifier reached its ordinary tool history;
both never reached its automatic evidence context. The run exhausted its
30,000-token admission allowance at 31,848 actual tokens and returned an empty
final response. This was an incomplete answer, not a substitution of current
file values or a failed archive tool.

## Change and source boundary

The SDK resolver now admits one nonempty, explicitly marked compaction summary
as a derived lookup reference. It takes a leading excerpt of at most 600 UTF-16
units, inside the existing six-excerpt and 64-message scan limits. The nearest
operator request remains represented when commentary fills the other slots.
Other system policy, tool text, private reasoning and unmarked prose headers
remain excluded. The planner is told that selected history is bounded: its
first entry does not necessarily represent the conversation's beginning.

Validated basis quotes retain their actual `system` role and a
`source: "compaction-summary"` marker. Only the host supplies this marker;
planner JSON cannot invent it. The summary can identify what to search for,
but requested facts must still come from original retained evidence. This does
not alter the original operator message, increase the planning allowance or
change the SDK's default recall configuration.

The inspected primary reference was Pydantic AI harness's
[conversation search toolset at c897c4e](https://raw.githubusercontent.com/pydantic/pydantic-ai-harness/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py).
It searches persisted history, ranks matches and separates matching text from
bounded display context. Namzu's derived-summary query input is a local design
decision; this source does not demonstrate or validate that planner change.

## Experiment construction

The [driver](natural-cli.mjs) creates isolated generated files. Its initial
scripted decision invokes the real CLI `read` tool on a 400-line file. Two
random identifiers are retained in the output artifact but absent from the
visible preview and assistant answer. The driver then replaces the source file
with different identifiers. Eighteen scripted turns each read a separate,
unrelated generated file through a new CLI process in the same conversation.
These setup turns consume zero live tokens.

The [compaction helper](compact-natural.mjs) invokes the actual
`Session.compact` entry point used by `/compact`. It reduces 76 visible messages
to nine, archives the 67 removed messages and verifies that the original read
preview survives in a strict-integrity archive. Neither original identifier is
in the resulting projection. Compaction itself makes no provider request in
this fixture. This is a direct call to the real entry point, not a keyboard
test of the `/compact` command.

Each historical follow-up starts another real CLI process. Live cases use
Codex `gpt-5.6-luna`, low effort, four iterations and a 120-second process
deadline. Historical turns admit up to 30,000 tokens; current-state follow-ups
admit up to 25,000. Admission limits are not exact billing ceilings. Provider
wire observations record structure and identifier-presence flags, not
credentials or private reasoning.

| Build and question | Observed recovery | Historical tokens | Current follow-up tokens |
| --- | --- | ---: | ---: |
| Base, explicitly names DELTA (`Tf4rkq`) | Correct originals in automatic context; no answer-time tool call | 10,506 | 18,840; fresh read, correct replacements |
| Base, names DELTA, injected failed plan (`G4lYyq`) | Availability note plus one explicit archive search; correct originals | 17,953 | Not run |
| Base, unnamed earlier record (`vVrEw2`) | Wrong subject in preparation; three archive searches, empty final at token budget | 31,848 | Not run |
| Candidate, unnamed earlier record (`8hh6pt`) | Summary-grounded preparation; correct originals in automatic context, no answer-time tool call | 11,188 | 20,063; fresh read, correct replacements |

The candidate's historical planner quoted the initial DELTA task from the
labelled summary. Its main request contained both originals only in the
5,051-character temporary context; neither appeared in ordinary active history.
The current-state planner then classified the follow-up as present time, and
the main model read the changed source file. Across all four live cases the
original output artifact and manifest hashes remained unchanged, and all
measured build fingerprints were stable during each case. The final candidate
matches its recorded production build fingerprints.

Total live usage was **110,398 tokens**, including planning. These are separate
generated fixtures, one per condition; discovery ordering and cache reuse can
differ. They do not establish an accuracy rate, an effect size or cost savings.
The failed-plan case is deliberate fault injection, not a measurement of
natural planner failure frequency.

## Fixture failures and offline control

Two earlier zero-live-token attempts found defects in the experiment driver.
They are retained in the observations rather than counted as product failures:

- `n1wftp`: repeated scripted tool-call IDs across turns were correctly rejected
  by the kernel. The report scanner then masked the primary error with an
  ENOENT on a budget-only, unstarted run. IDs now include the turn, and the
  scanner recognizes only that exact unstarted directory shape.
- `gRjVsy`: the scripted archive consumer selected the first search match, which
  was a compacted operator request rather than the original tool output. It now
  requires a `tool_completed` read and follows the cursor when necessary.
- `7iU3Is`: the corrected offline control completed real compaction, one archive
  search, one exact archive read and a current file read. It returned both old
  and new values correctly with zero live usage. This particular case found the
  original on its first page, so it does not independently exercise continuation.

## Real TUI and regression checks

The [terminal fixture](summary-recall-tui-fixture.mjs) restored only the
candidate's actual nine-message pre-question projection, leaving archived runs
intact. A real 100×28 PTY resumed that conversation. The historical question was
typed into the composer and submitted with Enter. Controlled model decisions
asserted that the query input contained the labelled summary and that the main
request recovered both originals solely through temporary context.

The xterm-parsed capture contains each original identifier exactly once, the
answer and an idle composer. The original output artifact and manifest hashes
still match their pre-experiment values, and the generated workspace still
contains the replacements. `/exit` returned zero. This terminal run used no
live model tokens and proves the real resume, retrieval and rendering path;
it is not another independent model-accuracy trial. Local capture paths and
hashes are included in the observations.

Five SDK regressions cover marked-summary eligibility, preservation of the
nearest operator, exclusion of policy and tool text, the 64-message boundary,
and the latest summary's leading excerpt with a UTF-16 edge. Four failed before
the implementation. A CLI test exercises actual Session compaction, persisted
projection, reopening and original-evidence retrieval while keeping the
operator question unchanged.

Workspace typecheck, lint, build and all package tests pass: **6,696 SDK tests**
and **2,978 CLI tests**, with five existing CLI skips. Lint reports warnings but
no errors. Docs conformance, 48 compiled SDK fences, 20 package README fences,
SDK test presence and signature exports also pass. The three changed experiment
scripts pass Node syntax checks. This records local verification, not completion
of every release gate or a publish.

## Remaining limits

A summary can omit a subject, misstate it or place it beyond the selected
excerpt; the resolver can still choose the wrong referent. Exact quote and
token grounding validate source inclusion, not semantic interpretation. This
change also does not fix the observed tendency to restart searches instead of
following a cursor. Those failures remain relevant controls for future work.
The broader autonomous-kernel and dynamic-context goal remains active.
