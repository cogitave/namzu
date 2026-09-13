# Grounded reference resolution in reopened CLI conversations

Recorded 2026-09-13, local implementation on base `66a33769`.
[Machine-readable receipts and source/build hashes](resolved-query-results.json).
These are bounded diagnostic trials, not a benchmark success-rate estimate.

The [previous experiment](referential-results.md) retained the original read but
could not retrieve it from “Az önce baktığın kaydın iki kimliğini aynen yazar
mısın?” A real Luna/low follow-up returned the replacement file's identifiers.
The query ablation isolated a missing referent: naming DELTA recovered both
originals. Blindly reusing the preceding question would also carry DELTA into an
unrelated new topic, so empty retrieval alone was not a sufficient trigger.

## Implementation and research boundary

The SDK now optionally asks the run's model for a small query plan using bounded
visible conversation. Contextual terms must occur in the question or exact cited
history quotes. Direct/present queries keep their current literal terms; `none`
skips retrieval. Invalid plans fail the optional preparation stage. The original
operator message, authenticated source scope and retrieval limits are unchanged.
The CLI enables this only with existing opt-in evidence recall; the new
`resolveEvidenceQueries: false` setting retains the former local-only behavior.

[ConQRR](https://arxiv.org/html/2112.08558v3) studies turning a conversational
question into a standalone retrieval query, with learned retrieval rewards and
separate topic-shift analysis. [Lin et al.](https://arxiv.org/html/2005.02230v2)
study term importance and neural query rewriting. Namzu's implementation uses
prompted, quote-grounded token selection: it does not implement either paper's
training algorithm or inherit their reported scores. The inspected
[Pydantic conversation search](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py)
is a retrieval reference, not evidence that it automatically resolves this case.

## Protocol

```sh
node research/conversation-evidence/natural-cli.mjs --referential --scripted-observation --recall-evidence --resolve-queries --check-current --check-topic --live
```

Every turn is a separate production CLI `run-stream` process, using the same
isolated recorded conversation. Initial model decisions are scripted to obtain
one real file read and a one-sentence summary without exposing the two random
identifiers in the 4,000-character preview. File tools, archive retention and
reopened Session execution are production code. The 400-line source is replaced
outside Namzu after the first process exits. All follow-up decisions and query
plans use live `codex/gpt-5.6-luna`, effort `low`.

Each historical turn allows four loop iterations, 30,000 run tokens and 120
seconds; current turns allow 25,000 tokens; the new-topic turn allows 15,000.
Planning spends the same run budget, up to 512 output tokens and ten seconds,
without adding a loop step. No benchmark harness changes the provider chunks.
The observer records visible planner output/usage and context presence. Total
spend comes from the run budget, including preparation, instead of summing only
main-model message events. Sources were unchanged during follow-ups and built
module hashes matched before/after each trial.

## Results

| Trial | Historical identifiers | Historical tokens, including preparation | Current identifiers | Current tokens | Topic switch |
| --- | --- | ---: | --- | ---: | --- |
| Baseline, prior recorded run | Wrong: answered from replacement | 17,009 | Exact | 18,477 | Query ablation only |
| `dH4gzi` | Both exact; no tool call | 9,632 (511 preparation) | Wrong spelling: localized `YENI/TAKIP` to `YENİ/TAKİP` | 18,176 (763 preparation) | Not run |
| `0WcxW7` | Both exact; no tool call | 9,635 (510 preparation) | Both exact, after fresh grep | 17,570 (790 preparation) | Direct plan; no retrieved context or shipping identifiers in answer |

Both live historical requests received the originals exclusively in the new
request-only evidence context (3,268 / 3,283 characters). Neither their ordinary
history nor their planner inputs contained the original identifiers. No workspace
read or archive tool call was needed for the historical answer. The second
trial's plan cited the prior assistant summary for `DELTA`, `takip`, `kodu`,
`hedef`, `depo`. It labelled the time `unspecified`, illustrating that strict
quote validation does not establish perfect semantic classification.

The current-state requests used new workspace observations. The first trial
still failed exact copying: its answer changed ASCII `I` to Turkish `İ`, although
the UUID suffixes and chosen source were correct. **That trial fails overall.**
The first raw report's historical `passed` field predated the driver fix that
combines current/topic checks; the checked-in results explicitly record
`historicalPassed` and `overallPassed` to avoid calling that run successful.
The second trial passed all three checks. Its new-topic turn cost 9,212 tokens,
including 685 for a direct query plan: planning adds overhead even when no
historical retrieval is needed. No latency or monetary-cost advantage is claimed.

## Verified limits and remaining work

SDK tests cover quoted grounding, excluded tool/private/policy inputs, bounded
history, current/new-topic handling, operator/run cache invalidation, malformed
plans and source revalidation. Kernel integration tests cover shared budget,
preceding model choice, fallback, cancellation, capability lifetime and invalid
output usage. Real CLI Session tests cover the default and explicit opt-out.

This fixes the measured referential retrieval gap on two live follow-ups. It
does not establish multilingual or long-history reference accuracy. Referents
outside six bounded visible messages remain unavailable; malformed plans skip
optional recall; literal-only mode preserves the previous limitation. Exact
identifier rendering remains fallible, as the first current-state answer proves.
The next separate investigation is final-answer fidelity against available source
text, preserving failures rather than silently normalizing a model's output.
