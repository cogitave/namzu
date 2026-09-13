# A referential follow-up still selects the wrong time source

Measured 2026-09-13 against `6c682d87`. This is a **known live failure**, not a
successful recall fix. [Raw observations](referential-results.json) retain the
answers, model usage, source fingerprints and passing scripted controls.

## Protocol

The [CLI driver](natural-cli.mjs) starts three independent `run-stream --session`
processes with an isolated application home and workspace. The first uses
scripted inference to call the actual `read` tool on a 400-line file, then emits
only a short description. Two random identifiers are retained beyond the visible
tool preview. The experiment requires a completed read and verifies that neither
identifier was exposed in the visible first-turn text. It replaces the workspace
file after that CLI process exits.

The first prompt names the record:

> sevkiyatlar.txt dosyasındaki DELTA kaydını incele; yalnızca hangi tür bilgileri içerdiğini bir cümleyle söyle.

Its scripted answer is `DELTA kaydı, takip kodu ve hedef depo bilgisi içeriyor.`
This explicitly controls the initial conversation. It is not evidence that a
live model would perform or describe that inspection the same way.

The subsequent historical question omits the name and field labels:

> Az önce baktığın kaydın iki kimliğini aynen yazar mısın?

The third question asks for the changed file's current values:

> Şimdi aynı dosyadaki güncel iki kimliği söyle.

Those two turns use real `codex/gpt-5.6-luna` inference at low effort. Each has
four maximum iterations and a 120-second process timeout; token admission
budgets are 30,000 and 25,000. A read-only provider wrapper records context
presence/size and whether the random originals are present, then forwards the
native stream unchanged. Automatic evidence recall is enabled; project-memory
recall and web search are off. This is a headless CLI test, not TUI rendering.

## Outcome

| Mode / question | Actual tools | Correct source values | Tokens |
| --- | --- | --- | ---: |
| Scripted historical control | archive search, exact archive read | Yes, originals | 0 |
| Live historical follow-up | workspace grep | **No, replacements** | 17,009 |
| Live current-state question | workspace read | Yes, replacements | 18,477 |
| Scripted current-state control | workspace read | Yes, replacements | 0 |

The live trial spent 35,486 reported tokens. Both live turns reached `end_turn`
without tool errors. The original values were retained, absent from first-turn
visible text, and absent from every observed live provider request. The first
historical request had zero automatic recall context characters. Later context
still did not contain either original. The historical answer substituted the
replacement identifiers exactly; this is a source-selection error, not a
spelling or corruption failure. The external replacement remained unchanged.

The scripted control recovers both originals through the current archive tools,
including after reopening. It proves a usable retrieval path in this fixture;
it does not prove that the live model will choose it. No original read effect
was replayed by that recovery path. The live sample used a fresh workspace
observation and therefore did not answer the historical question correctly.

## Query ablation on the same retained observation

Before follow-up execution, a separate zero-model ablation loads the actual
first-turn conversation and calls the existing CLI recall step with four
different query texts. This changes only the retrieval query, not archive bytes.
The standalone query is manually supplied as an oracle; no implemented query
rewriter produced it.

| Supplied query | Added context | Original identifiers selected |
| --- | ---: | --- |
| Referential follow-up above | 0 characters | Neither |
| Previous operator's inspection request | 2,809 characters | Both |
| Explicit standalone DELTA historical question | 2,809 characters | Both |
| New topic: `Akdeniz ikliminin özellikleri nelerdir?` | 0 characters | Neither |

The two positive scans each report 225,635 accounted bytes, complete traversal
and no omitted passages. These are sequential scans with a reusable disposable
index, not cold-latency comparisons. The ablation verified unchanged transcript
hashes. Empty added context does not mean zero disk reads.

**Inference from this fixture:** an empty current-query result cannot distinguish
a referential follow-up from an unrelated new topic. Both return no evidence.
Blindly falling back to the previous operator's query would supply the same
shipping identifiers to either question. This was not shipped as an automatic
fallback. It is not a measured live answer failure on the climate question.

## Primary-source comparison and next implementation requirement

[ConQRR, version 3](https://arxiv.org/html/2112.08558v3) uses dialogue context to
produce a standalone retrieval query and trains toward retrieval results. Its
analysis also treats topic shifts separately. This supports evaluating resolved
queries by what they retrieve, rather than by whether a rewrite sounds plausible.
It does not establish performance for Namzu's Turkish file-history task.

[Lin et al., version 2, section 4.1](https://arxiv.org/html/2005.02230v2#S4.SS1)
describes historical query expansion with keyword importance and query ambiguity
estimation, alongside a neural reformulation path. Its collection-level signals
and trained components are not equivalent to adding the immediately preceding
prompt whenever Namzu's bounded page is empty. Its reported retrieval scores
must not be transferred to Namzu.

The inspected Pydantic AI Harness checkout is clean at
`c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504`. Its
[conversation search toolset](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py)
ranks a supplied query with BM25 and documents when historical search is useful.
That code is a retrieval reference; it is not evidence of automatic resolution
of the follow-up tested here.

The next query-resolution implementation must be evaluated on referential
follow-ups, explicit record changes, unrelated topics and historical/current
contrasts. It must preserve the actual operator question, expose the basis for
any contextual retrieval, retain exact scoped evidence, and account separately
for any extra inference, latency and I/O. Generic acknowledgments must not cause
arbitrary archive browsing. Incomplete discovery must stay incomplete. A
standalone oracle succeeding is a target, not proof that this capability exists.

## Reproduction and validation

```sh
node research/conversation-evidence/natural-cli.mjs --referential --scripted-observation --recall-evidence --check-current --query-ablation
node research/conversation-evidence/natural-cli.mjs --referential --scripted-observation --recall-evidence --check-current --live
```

The second command intentionally exits nonzero when the historical answer is
wrong. Inspect `result.json`; a provider/process failure is not a recall sample.
Failed initial prerequisites now stop the trial before live follow-ups. Module
fingerprints must remain unchanged during a trial. The scripted control and
query ablation passed; the live historical outcome remains unresolved. This
change adds a reproducible diagnostic and documents the gap; it changes no
production SDK or CLI behavior.

Artifacts: `/tmp/namzu-natural-recall-Tg7MXP` (scripted),
`/tmp/namzu-natural-recall-0TGiSr` (live failure),
`/tmp/namzu-natural-recall-ejnVxZ` (final scripted control plus query ablation).
