# Closing a run without upgrading claims into facts

2026-09-13. The prior natural CLI trial recovered only an assistant claim but
asserted it as a file value in closing prose. The runtime was asking for a
final, comprehensive response at the resource warning. That wording did not
explicitly preserve uncertainty when the task could not be established.

The kernel now asks for a concise response supported by available evidence,
attribution of unverified claims, and unresolved evidence or unfinished work.
The same request-local guidance applies to empty-completion recovery. It adds
no judge, tool request, persistent instruction, factuality label or new limit.
It does not change the existing forced-closing `token_budget` settlement.

This is an instruction change evaluated locally, not an implementation of a
published hallucination detector. [RAGTruth](https://arxiv.org/abs/2401.00396v2)
documents unsupported and contradictory claims even when retrieved material
is available; it motivates checking the generated claim rather than treating
successful retrieval as a correctness score.

## Controlled live suffix

`source-support-review-cli.mjs --replay=<report> --live-closing --baseline`
replays only the original three search-call and usage receipts. The actual
conversation tools run against a fresh isolated CLI Session. Only the final
tool-free closing request goes to `gpt-5.6-luna`, at `low` effort. This limits
new inference to one closing response per trial. It does not measure the
model's choice of searches or simulate their original wall-clock latency.

The existing fixture admits 26,000 tokens, six iterations and a 120-second
outer deadline, with 1,024 requested output tokens. Each replay prefix charges
24,245 **synthetic** tokens to exercise the warning path. These are recorded
accounting inputs, not new provider spend. The final live response can take
measured accounting above the allowance; the final run remains `token_budget`.

`--legacy-closing` substitutes only the previous closing instruction in the
last provider request. The two claim-only trials had identical semantic tool
result fields after excluding run IDs, recorded wall-clock stamps, opaque
cursors and scan-byte counters. Session identities, times and provider cache
hits differ; these are single controlled samples, not an exact repeated wire
request or a statistically supported effect estimate.

| Trial | Closing response | New live tokens |
| --- | --- | ---: |
| Previous instruction, claim-only archive | Asserted the code as the original file value | 8,824 |
| New instruction, same claim-only evidence | Attributed the code to the archived assistant statement and said it was not an independently visible file observation | 8,870 |
| New instruction, direct-observation control | Returned the exact code in the retained `read` observation | 8,791 |

Total new reported usage was **26,485 tokens**, including 6,656 cached tokens
in the previous-instruction trial. No judge request ran. Every trial made
exactly one live closing request; production build hashes stayed unchanged
within each trial. The two attribution outcomes and the positive control are
retained verbatim in `closing-guidance-results.json`. This does not establish
an error rate, cost saving or a generally reliable abstention policy.

The positive control is deliberately constructed: it reuses the recorded
three-search prefix and usage from the claim-only trial, but seeds the
existing `direct-observation` fixture. It is **not** a natural observed
trajectory. The report records the construction and resulting tool payloads.

## Replay validation failure before live inference

The first offline replay correctly stopped before its closing request because
the fresh first search had already exhausted its corpus. The original trial
had returned a continuation. Explicit search visits UUID-sorted runs, so fresh
random IDs had changed whether the current run preceded the seeded archive.
The old opaque cursor could not simply be reused in another process.

The replay fixture now uses a low, fixed synthetic archive UUID to keep its
source ahead of the current run, requires the actual continuation to exist,
and rebinds each recorded cursor through the corresponding tool-call result.
It refuses tool errors before a live suffix. This changes the research setup,
not production ordering or cursor validation. The corrected offline replay
completed with actual searches and zero live inference; the failed setup is
also retained. Prior replay results without cursor calls were unaffected.

## Actual TUI and regression checks

The built interactive CLI ran in a real 100-column, 28-row PTY with
`forced-close-tui-fixture.mjs`, using scripted provider transport. The actual
file tool read the synthetic receipt once. The second request carried the new
attribution guidance with `toolChoice: none`. The screen showed the retained
closing text, one `Run stopped` notice and an idle composer; `/exit` exited
zero. Installed `@xterm/headless` replayed the captured ANSI. The report keeps
the final frame and provider-request assertions. This TUI check uses zero
live inference tokens and does not test factual reasoning.

Two new runtime cases check warning closure and empty-completion recovery:
the guidance reaches the request, tools remain forbidden, the nudge is absent
from persisted history, and stop reasons remain correct. Twenty-six focused
tests passed across closing settlement, completion delivery and effort on all
inference paths. Initial TypeScript checks rejected a test predicate that
assumed runtime context had a system role; it was corrected to the actual
user-role runtime-context contract, rather than weakening the message type.

Full workspace typecheck, lint, tests and build then passed. The SDK passed
6,684 tests; the CLI passed 2,957 with five skips. Documentation conformance
and 48 compiled TypeScript fences plus package README fences passed. Existing
lint warnings remain. This is local verification, not all release gates or a
published version.

The broader vision remains open. These samples support retaining a less
coercive closing instruction, but do not prove natural retrieval will stop
efficiently, preserve uncertainty in every case, or complete an autonomous
objective without further evidence and acceptance checks.
