# Natural historical questions: an unresolved source-selection failure

Measured 2026-09-12 on Linux/WSL with Node 24.19.0. **Natural source selection
is not validated by this experiment.** Retention and exact retrieval work in
the scripted control; both eligible live samples answered a historical question
with the changed file's current values. The later live sample had an incomplete
initial inspection and does not establish recall performance.

A later [referential follow-up experiment](referential-results.md) tests the
newer retrieval implementation after `6c682d87`. Its controlled initial read
qualifies, but a live question omitting the record name still selects current
workspace values. It records that separate failure and a query-resolution ablation.

[Raw results and source fingerprints](natural-results.json) preserve the
failures, terminal stop reasons, individual calls, exact synthetic identifiers
and per-request usage. The [CLI harness](natural-cli.mjs) launches independent
processes sharing one conversation. Live runs use the native Codex provider
without wrapping or replacing its decisions.

## Protocol

An isolated workspace contains a 400-line shipping inspection file. Two
unpredictable UUID-bearing identifiers occur outside the retained preview.
The first prompt asks for an inspection and a one-sentence description:

> sevkiyatlar.txt dosyasının tamamını incele; yalnızca hangi tür kayıtlar içerdiğini bir cümleyle söyle.

After this process exits, the experiment replaces the file with new identifiers
and starts another CLI process in the same conversation:

> Az önce incelediğin dökümde DELTA siparişinin takip kodu ve hedef deposu neydi?

Neither prompt names a tool, archive, cursor, or recovery strategy. The optional
third turn asks for current state to check for an inappropriate historical answer:

> Peki aynı siparişin güncel dökümdeki takip kodu ve hedef deposu ne?

The live model is `codex/gpt-5.6-luna`, effort `low`. Admission limits are six
iterations per turn and 25,000 / 50,000 / 25,000 tokens respectively. These are
run admission limits, not hard billing ceilings: a final admitted request can
take usage above a limit, as the third live sample demonstrates. Each CLI
process also has a 180-second wall-clock timeout. No user workspace is edited.

Success requires exact original identifiers, no substituted replacement,
unchanged external fixture, no process/protocol failure and completed turns.
The experiment separately checks that both originals were actually retained
and absent from visible initial results. A successful read receipt alone does
not establish that the model saw every retained byte. The current-state check
requires exact replacement identifiers, not necessarily an extra read when
fresh evidence is already in context.

## Observations

| Condition | Historical turn's calls | Original answer | Current-state check | First two turns' reported tokens |
| --- | --- | --- | --- | ---: |
| Scripted control before changes | search → exact read | Correct | Not run | 0 |
| Live baseline | workspace grep | Wrong: replacement | Not run | 30,057 |
| Live with capability/source guidance | history search → workspace grep | Wrong: replacement | Identifier spelling changed | 46,407 |
| Live with continuation guidance | workspace grep | Wrong: replacement; initial inspection incomplete | Correct | 47,205 |
| Final scripted control | history search → exact read | Correct | Correct | 0 |

The capability-guidance sample searched history but got only its own statement
that it was searching for DELTA. The response had `incomplete: true` and a
`nextCursor`; the original read was on a later page. The model then searched the
current file instead of following the cursor. Its third answer changed ASCII
`YENI-TAKIP` to `YENİ-TAKİP`. The UUIDs remained the same, but exact identifier
assertions correctly rejected this spelling change. Total usage including that
third turn was 55,124 tokens.

In the continuation-guidance sample, the first turn used glob, read, bash and
grep, consumed 29,941 tokens against a 25,000-token admission limit, and stopped
with `token_budget`. Bash also exposed both original identifiers. It is therefore
**ineligible as a missing-detail recall trial**. The historical answer was still
wrong despite the available identifiers; the current-state answer was correct.
Total usage including the third turn was 65,070 tokens. The final harness now
checks completion explicitly. Earlier raw records remain unchanged, and the JSON
assessment applies the stricter eligibility criteria to them.

The first two live samples were eligible and failed. These are diagnostic
examples, not an estimated success rate. Random run IDs can change which run's
bounded page is visited first; the model also made different choices. No cost
improvement or comparison against another harness follows from this table.

## Source comparison and changes

The pinned Pydantic AI Harness's
[conversation capability](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_capability.py)
provides retrieval instructions only with the capability and describes its
configured scope. Namzu adopted that separation: generic SDK evidence rules
describe historical versus current sources; recorded CLI hosts add stable
instructions naming their mounted conversation tools. Stateless sessions get
no instruction to seek unavailable tools. Ordinary, resumed and resident CLI
prompt construction share this capability guidance.

Search results now explain pending pagination directly when a cursor exists,
including pages containing only announcements. An incomplete result without a
cursor instead explains omitted/unavailable evidence. The SDK reporting rules
also require exact identifier spelling. None of these changes expands storage
scope, relaxes integrity checks, repeats an action or forces a tool choice.

The regression suite exercises announcement-only first pages followed by exact
original tool text, empty continuation pages, unavailable evidence, real CLI
Session execution, resident admissions, and capability absence. Existing native
OpenAI/Anthropic request tests verify that the instructions are present while
changing inventory stays after history. Scripted model choices validate wiring
and contracts; they are not evidence that a live model follows the guidance.

On the final source, workspace typecheck, build, lint and tests passed, including
6,299 SDK tests and 2,831 CLI tests (five CLI skips). All 255 SDK process tests
passed, as did the documentation conformance and fence gates. Lint still reports
existing warnings. Release coverage, consumer installation, publication and a
new live TUI screen check are not claimed.

## Reproduce and next boundary

From a built checkout:

```sh
node research/conversation-evidence/natural-cli.mjs --check-current
node research/conversation-evidence/natural-cli.mjs --live --check-current
```

The second command consumes subscription usage. Its temporary directory holds
the result JSON, terminal NDJSON and real session transcripts. Live execution
requires usable local Codex credentials; offline execution scripts only provider
responses while exercising the actual CLI, files, tools and session store.

Static guidance alone is not sufficient evidence of reliable recall. The next
SDK work should evaluate bounded retrieval of relevant historical candidates
into request context, with original source/time provenance, before leaving all
source discovery to the model. That requires explicit budgets, host scope,
integrity, current-versus-historical counterexamples and unassisted live checks.
It must not turn a past observation into proof of current state or equate a
stored artifact with information the model has understood. This remains open;
no autonomous-memory milestone is marked complete by these measurements.

## Follow-up

The subsequent [automatic recall experiment](automatic-results.md) adds bounded
candidate ranking and request-context attachment. The earlier samples above
remain unchanged; they describe the implementation tested at that time.
