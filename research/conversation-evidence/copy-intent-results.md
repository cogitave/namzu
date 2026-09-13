# Source identity and the requested result are different contracts

Recorded 2026-09-13 on base `2d26b445`.
[Machine-readable trials](copy-intent-results.json).

## Question and primary sources

The [request-context reviewer experiment](review-request-results.md) made a
task-specific exact-copy check possible after historical evidence recall. That
does not justify installing its `answer === recordedIdentifier` predicate for
every ordinary conversation. An operator can legitimately request a transformed
value or an unrelated example. The source's identity is not the answer contract.

[ALCE](https://arxiv.org/abs/2305.14627v2) evaluates correctness and citation
quality separately. Its [evaluation implementation](https://github.com/princeton-nlp/ALCE/blob/246c476a4edfc564266b7346b6e29ef4861ae937/eval.py)
also distinguishes normalized exact-match checks from citation entailment. Its
[normalizer](https://github.com/princeton-nlp/ALCE/blob/246c476a4edfc564266b7346b6e29ef4861ae937/utils.py)
lowercases text and removes punctuation, articles and extra whitespace. Those
choices are useful for its QA metrics; importing them as proof of exact
identifier fidelity would erase some of the differences Namzu needs to detect.
This experiment does not run ALCE, its NLI model or its training procedure.

Our derived requirement is to keep three checks distinct: authenticated source
bytes, what operation the operator requested, and whether the candidate performs
that operation. Request visibility provides the first check's inputs, not a
complete specification of the other two. A task-specific host validator remains
useful; no universal string-equality gate or Unicode repair is installed here.

## Protocol

[copy-intent-cli.mjs](copy-intent-cli.mjs) runs the production built CLI
`run-stream` entrypoint in separate processes. A scripted seed uses the real
`read` tool on a 350-line manifest and records a short summary. The random
`TAKIP-<UUID>` appears outside the visible tool preview and is retained in the
archive. The file is then replaced externally. Each scenario receives a separate
copy of the synthetic seed state, so earlier scenario answers cannot become later
retrieval sources. Every follow-up uses the same recorded conversation through
`--session`, with existing opt-in evidence recall enabled and query resolution
off to isolate answer behavior from query planning.

The scripted control replaces model decisions only. Live follow-ups use
`codex/gpt-5.6-luna`, effort `low`; no expected-answer environment value is
supplied to a live model, and its request/response stream is forwarded unchanged.
An observer records request-only context, identifier presence in ordinary string
message bodies, usage and tool starts. The parent compares the settled `done.text`
with a task-specific expected value using exact JavaScript string equality,
without trimming or normalizing it. The hypothetical unconditional-copy rule is
evaluated after the run; it is never installed as a runtime reviewer.

Each follow-up has a 12,000-token **admission allowance**, three loop iterations
and a 90-second process deadline. The seed separately has the same admission
allowance, three iterations and 30 seconds, with zero model spend. These are not
hard token-spend ceilings: [the budget contract](../../docs/sdk/token-budgets.md#limits-of-the-guarantee)
admits while measured allowance remains, and an admitted response can overshoot.
The baseline Unicode case demonstrates that limitation with 16,776 measured
tokens. All reported receipts have zero unresolved requests. Strict tool
permissions are used; the replacement file stays unchanged in every trial.

The observer's temporary paths, source IDs and receipts are synthetic. No user
conversation or credential is checked into the results. Built-module hashes
match before/after each trial. Seed/inference scripting is explicitly identified;
this is an actual CLI-process experiment, not a TUI visual test.

## Results and the guidance change

| Trial | Task results | Tool calls after seed | Measured model tokens |
| --- | --- | --- | ---: |
| Scripted controls, `P2uxM0` | 6/6 | None | 0 |
| Baseline live suite, `GEBfs6` | 5/6 | Unicode request: `read`, then `grep` | 58,203 |
| Baseline clarified Unicode request, `3pRxXb` | 0/1 | None | 8,325 |
| Revised guidance, same clarified request, `owQHdg` | 1/1 | None | 8,483 |
| Revised guidance, original suite, `1l7t3K` | 6/6 | None | 49,657 |

All live trials reuse the same source identifier. Baseline and revised suites use
the same six prompts. The latter also passes both direct-copy cases (Turkish and
English), lowercasing, replacing the prefix with `TAKİP`, adding `test:`, and
returning a new `TEST-42` example instead of the historical identifier.

The original Unicode prompt asked to change only the prefix and output only the
result. The model instead announced it would verify the current DELTA line,
read the replacement file, searched it, and stopped on token budget without an
answer. Explicitly describing the operation as answer-only text transformation
and excluding file actions removed the tool detour, but still failed: the model
changed the record label to `TAKİP` while leaving the identifier's `TAKIP` prefix
unchanged. This second failure is preserved verbatim in the data.

The recall header previously said to preserve exact IDs unconditionally. It now
distinguishes quoting an ID exactly from deriving a value through an explicitly
requested text transformation. Existing historical-source, preview/error,
non-replay, chronology, incomplete-scan and continuation guidance remains.
Retained excerpts and read addresses are unchanged. The revised header is one
character shorter than the original, so clarification does not buy room by
increasing the context allowance. Existing small-budget passage/address and
omission regressions pass with their original limits.

On the final suite, applying the earlier task-specific whole-answer equality
predicate unconditionally would reject **four correct answers**: lowercase,
Unicode transformation, added prefix and new example. This is an intentionally
simple counterexample to reusing that predicate outside its task. It does not
measure a shipped Namzu policy's false-positive rate or imply that all source
validation is unsuitable. The clarified trial supplies an additional correct
Unicode transformation that the same unconditional predicate would reject.

Total live spend across the four live trials is **124,668 tokens in 15 model
requests**. No extra judge model is involved. The change is a prompt-contract
clarification, not an automatic fidelity repair. One matched example per case,
fresh archive IDs/timestamps and stochastic inference do not establish a causal
effect size or production success rate. The two baseline failures remain failed;
later successes do not relabel them.

## Reproduction and next boundary

After building the revision to inspect, without rebuilding during a trial:

```sh
node research/conversation-evidence/copy-intent-cli.mjs
node research/conversation-evidence/copy-intent-cli.mjs --live
node research/conversation-evidence/copy-intent-cli.mjs --live --clarify-transform --identifier-from /absolute/path/to/result.json
```

Each invocation prints its own temporary result directory. `--identifier-from`
copies only a validated synthetic identifier into a fresh seed; it does not
resume or mutate that trial's conversation. Expected answers are a test oracle,
not a private runtime-review channel. The final line's `completed` means the
protocol finished with stable builds and source files; inspect `taskPasses` and
individual outcomes for success. A failed task gives the driver a nonzero exit.

The next general verifier needs a grounded task/claim contract, not just source
availability or lexical resemblance. It must preserve explicit transformations,
distinguish current-state questions, tolerate legitimate new examples, and avoid
turning optional retrieval errors into invented factual verdicts. This change
does not solve arbitrary semantic verification, ambiguous intent, or every
exact-copy failure in the earlier evidence trials.
