# Derived work context: visibility, observations and unfinished synthesis

The [natural TUI baseline](natural-terra-tui-results.md) exposed two behaviors:
an unchanged, just-written file was read again, and an intervening question
received an answer while completed delegated results needed another user turn.
The implementation addresses the data available at the decision boundary.
It does not infer user-facing task completion from transport delivery.

## Architectural choice

[Pydantic AI's history processing](https://pydantic.dev/docs/ai/core-concepts/message-history/)
separates stored conversation from the history supplied to a model. Namzu already
has that separation through request projection and `step-context`; this change
uses it instead of introducing another persistent store or modifying canonical
history. The [Lost in the Middle study](https://arxiv.org/abs/2307.03172v3)
demonstrates position-sensitive use of supplied evidence in its evaluated models
and tasks. It motivates testing explicit current context here; it does not prove
an improvement for Terra or explain this baseline's behavior by itself.

The projection is in the SDK provider-input path, including its closing request,
so CLI applications and other hosts use the same semantics. It carries runtime
user-role provenance, leaves system policy unchanged and cannot replace the
kernel's separately retained operator input. Tests examine actual captured
provider requests and canonical history independently.

## File evidence

Let `R_t` be the final projected history and `O_c(p)` the conversation's most
recent content observation fingerprint for path `p`. A reference is admitted
only when all these predicates hold:

```text
visibleFullWriteBody(c, R_t)
AND uniqueCallAndSuccessfulReceipt(c, R_t)
AND observedFullWriteCallId(path(c)) = c.id
AND fingerprint(body(c)) = O_c(path(c))
```

The join is recomputed for every request. Cleared receipts, truncated arguments,
ambiguous IDs, missing observations and changed hashes withhold the entry.
The full body remains in its original call; the projection adds only a path,
call ID and fingerprint. It performs no filesystem reads. A later observation
without content now clears the earlier fingerprint: unknown newer information
cannot certify an old body as the most recent observation.

The first live prototype used function identity to recognize a built-in write.
CLI checkpoint wrappers replace that function, so this check withheld evidence
and Terra read the file again. The corrected design records `toolUseId` at the
successful full-body write in the existing observation ledger. A transparent
wrapper preserves this execution witness. A matching read or a tool's name alone
does not produce it. The cross-turn regression now executes a wrapped write.

This is an observation equality check, not an assertion that disk state is
unchanged. Mutation admission still reads the target under the existing process
lock and refuses drift before editing. External writers can still race after
that read. Existing fingerprints use 64 bits of SHA-256; equality is not a
collision-free or adversarial integrity proof. This change does not alter that
contract or introduce filesystem compare-and-swap. Full-read reconstruction and
reconstruction across chains of edits remain outside this projection.

## Delegated work

For each owned task `i`, the projected state is the product:

```text
D_i(t) = (schedulerState, childRunStatus, stopReason, resultDelivery)
resultDelivery ∈ {not-delivered, delivered-to-history}
```

The scheduler is the state source; `claim`/`drain` own delivery. Reading the
projection changes neither. Thus `delivered-to-history` never implies that a
human received a synthesis, that retained output still fits in the current
request, or that a terminal child completed its assignment successfully.
Missing scheduler observations remain unknown. Other runs' work and result
bodies are excluded. A bounded recent-ID list avoids enumerating a shared
gateway or allocating another copy of every owned result.

The model is directed to answer steering while finishing the requested
synthesis unless the operator cancels or changes it. A free-text answer's
semantic completeness is not deterministically provable from task state, so no
fictional `reported` bit is inferred and no forced retry loop is added.
Behavioral improvement must be assessed in the live comparison.

## Resource bounds and verification

The file join is linear in visible history and admitted argument text; each
parsed argument is capped at 32,000 UTF-16 units. At most six file references
survive. A worker snapshot makes at most sixteen scheduler observations,
retains no body and reports an omitted count. Empty projections incur no
additional request-room measurement. Each nonempty contribution must fit
8,000 characters and 2,000 estimated tokens, with remaining-room reserves
described in [the SDK contract](../../docs/sdk/step-context.md#derived-work-context).
These limits bound the added context, not model billing.

Regression checks cover missing/cleared/ambiguous evidence, changed and unknown
observations, custom tools and trackers, sandbox path identity, cross-turn disk
drift, owned versus foreign workers, incomplete outcomes, failed state reads,
delivery without consumption, steering provenance and low request room. An
additional CLI test assertion separates operator input from trailing runtime
context instead of assuming the last user-role message was typed by a person.

## Live TUI verification

The [retained evidence](derived-work-context-results.json) records three real
TUI processes, exact operator messages and approvals, synthetic file snapshots,
terminal frames, tool execution/results, source/build hashes and usage. Base
commit: `80f2c6dc`; these runs used the changed source, with CLI still displaying
24.0.0. Linux PTYs were 120×34, replayed through installed `@xterm/headless`.
Each process had an isolated workspace and `NAMZU_HOME`; credential discovery
used the installed Codex account without editing personal state. Web search and
sandboxing were off. Permissions remained on with individual approvals.

All parent runs used Codex GPT-5.6 Terra with `/effort low`. The four actual
children used Terra; their metadata omitted effort, so they are recorded as
default rather than asserted to inherit low. No Muse or Luna run was used.
Reasoning, provider-native envelopes and credentials are excluded from retained
evidence. All thirteen SDK runs ended with `end_turn`, all three processes
exited 0, and final budgets had no in-flight or unresolved requests.

| Experiment | Observed outcome |
| --- | --- |
| Function-identity prototype, two parent turns | Write followed by `read → edit`. The CLI checkpoint wrapper prevented admission of the write reference. This failed prototype is retained. |
| Execution-witness variant, create-then-append wording | First turn used `write → edit`, with no intervening read. The next turn still used `read → edit`: edit-chain reconstruction is outside this implementation. |
| Same initial and follow-up wording as the earlier baseline | First turn used one write. The next turn proposed an edit without first reading the just-written file. |
| External mutation while that edit's approval was pending | After approval, the existing admission check refused the stale edit. The model read the new file and proposed a revised edit. The manual meeting line remained byte-for-byte intact after approval. Actual sequence: `edit (refused) → read → edit (success)`. |
| A later append after an edit | `read → edit` again. The final “İyi çalışmalar!” line was added and the manual line remained intact. |
| Two agents, uninterrupted | Both finished and the parent gave both correct meeting summaries. It reread both files to verify their results. |
| Two new agents plus steering | The operator submitted the side question while both children were active. The parent answered “İyi çalışmalar!” and then gave both newly changed meeting summaries without another user question or a replacement child launch. It still reread the two files for verification. |

The first attempt to time steering watched only top-level run records and
missed child records under `children/`. No steering was sent in that attempt;
it is an uninterrupted two-agent observation, not a passing steering test.
After fixing the driver, the operator changed both fixtures to previously
unseen values and asked, “Dosyalar değişti, iki ajanla tekrar inceleyelim;
toplantı bilgilerini kısaca söylesinler.” While both new child runs were active,
the operator sent, “Onlar bakarken söyle, az önce dosyaya en son ne ekledik?”
The timestamps establish submission during both children's lifetimes. The
parent's response covered the side question and the new results: Deniz,
Thursday 16.45, Turkuaz; Ada, Tuesday 11.20, Zeytin. No further question was
needed before `/exit`.

This is not a paired benchmark: the model's generated content can differ, the
external edit was deliberately moved into the approval window, and the
steering retry used changed fixtures. The first two messages of the matched
conversation are identical to the earlier baseline; the variants retain their
different wording. A single observed improvement does not establish an
expected success rate, a token-saving estimate, general long-horizon recall,
learning or RSI. The original baseline remains unchanged.

The prototype used 45,168 cumulative request tokens, the edit-chain variant
55,298, and the matched conversation including its additional agent test
220,765 (137,216 reported cached). These are summed request usage, not final
context sizes or verified monetary charges. No comparison of these unequal
workloads is presented as an efficiency score.

## Final checks and remaining scope

- Workspace typecheck, build and lint passed; lint retained existing warnings.
- SDK: 6,932 tests across 691 files passed.
- CLI: 3,131 tests across 346 files passed, with five skipped.
- SDK process suite: 269 tests across 41 files passed.
- Docs conformance and fence gates passed; 55 fences and 20 package READMEs
  were checked, with one declared sketch excluded.
- Signature-export and SDK test-presence gates passed. Check-log hashes and
  diagnostic assertions are retained in the evidence JSON.

An initial CLI regression run exposed four tests that assumed the last
user-role message was always operator input. Their assertions now identify
operator provenance explicitly and also verify trailing runtime context;
the subsequent complete CLI run passed. An intermediate wrapped-tool fixture
also needed its concrete tool type preserved for TypeScript; final typecheck
passed. These intermediate failures are not counted as passing runs.

The kernel deterministically validates and bounds its projection; it does not
deterministically prove a free-text answer's completeness. Full-read bodies,
edit chains and resume-time reconstruction of observation witnesses remain
outside this change. A changed or unknown observation removes the optimization,
and an unavailable result still needs retrieval. Parent verification reads
remain possible and can be deliberate. No release, publication, coverage floor
or complete release-gate result is claimed for this local change.
