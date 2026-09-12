# From bounded automatic recall to explicit continuation

Measured 2026-09-12 on Linux/WSL. Automatic recall revalidated its source at every
step but discarded the continuation after its four-page allowance. A missing
passage could therefore remain beyond the same repeated scan. An incomplete
batch with no newly selected passage also produced no context, hiding the
distinction between incomplete retrieval and a complete empty result.

## Source comparison and design

The pinned Pydantic AI Harness [history source](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_source.py)
and [search tool](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py)
were inspected locally. Its adapter separates persisted original messages from
their current projection and materializes the selected corpus for ranking.
Namzu instead has bounded authenticated pages, so retrieval may finish a call
without exhausting that corpus. This comparison motivates an explicit handoff;
it does not attribute Namzu's continuation mechanism to that source or claim a
comparative performance result.

SDK recall now accepts bounded host-supplied continuation calls and preserves
incomplete status without a selected passage. The CLI bridges its unfinished
live-writer and closed-history scans to the existing `search_conversation` tool.
Passing only `cursor` restores the exact host-owned query, including the
multi-term scan and excluded invocation; the model need not guess those fields.
An optionally repeated explicit query, case setting or run scope must match.

The bridge stores no evidence bytes and grants no new access. Calls revalidate
conversation membership, source state and cursor lifetime. Live continuations
require the same invocation's capture capability and cannot downgrade to a
closed or legacy source after that owner disappears. Automatic passes still
start at current source state; the explicit tool gives the model a way to make
progress beyond their bounded allowance.

## Production CLI experiment

The [CLI script](continuation-cli.mjs) creates an isolated synthetic archive:
nine matching announcement records followed by one oversized tool observation.
The observation's two random identifiers are beyond its 1,000-character preview
and retained in an integrity-checked spill. Ordinary conversation history holds
only a summary; the workspace file no longer holds the original content.

Natural prompt: **“DELTA kaydının takip kodunu ve hedef deposunu söyler misin?”**

It invokes the production CLI `run --resume`, with automatic recall enabled,
Codex `gpt-5.6-luna`, `low` effort, at most six iterations, a 30,000-token admission
budget and a 120-second process deadline. The live preload records provider
requests and forwards model decisions unchanged. The scripted control follows
the actual emitted continuation, then returns the real tool output.

| Trial | Result | Search calls | Requests | Tokens |
| --- | --- | ---: | ---: | ---: |
| Previous build, scripted | Incomplete metadata present, original absent, no continuation supplied | 0 | 1 | 0 |
| Updated, scripted | Supplied continuation recovers both originals | 1 | 2 | 0 |
| First live trial | Correct answer, but restarted search and mixed a recall cursor with another query | 3 | 4 | 30,130 |
| Final live trial | Used first supplied cursor directly; both originals recovered | 1 | 2 | 14,974 |

The first live trial failed the script's direct-handoff assertion. It eventually
used a later supplied recall cursor and answered correctly with `end_turn`, but
that does not satisfy the intended efficient path. Inspection found the search
result's older instruction still asked the model to repeat query/case fields.
That guidance now consistently recommends cursor alone; recall framing asks for
the supplied input unchanged. The failed trial remains in the raw report, rather
than being relabelled as a pass.

The final trial used `search_conversation({cursor: ...})` once, returned both
exact identifiers, and ended with `end_turn`. It performed no workspace read,
write or external action replay. Built-module fingerprints stayed unchanged
during each trial. This is one successful natural-language trial after a
guidance fix, not evidence that every model always chooses the best next call.

Both live trials together used 45,104 unpriced tokens. The admission budget is
not a promise of an exact billing ceiling: the first run reported 30,130 tokens
against a 30,000 admission budget. Unknown pricing does not imply zero cost.
This short fixture does not claim a new live compaction or arbitrary-length
archive benchmark; existing Session tests exercise actual compaction separately.

## Validation

SDK tests cover empty/incomplete scans, already-visible matches, bounded and
escaped hints, malformed metadata, omitted-hint accounting and complete-result
contradictions. CLI tests cover restoring host multi-term queries and exclusions,
concurrent reuse, wrong scopes, changed case/query, expiry, and live continuation
after append without replay or fallback after owner loss. A real CLI Session
test records through the SDK writer and verifies one production search call
continues beyond the automatic page allowance to recover the original.

Workspace typecheck/build/lint/tests, SDK process tests, docs and signature checks
are recorded in the accompanying JSON. After the paid trial, a guard was added
to reject live handles longer than 4,096 characters before retaining a bridge.
That refusal is covered by a dedicated test; the final CLI suite and a final
scripted production-CLI control were rerun. The successful live path was not
repeated solely for that invalid-input guard. Release-only coverage and
consumer-install gates are not claimed here. No push or release was performed.
