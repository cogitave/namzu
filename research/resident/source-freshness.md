# Source-bound guidance and real terminal observations — 2026-09-14

This follow-up implements a missing validity boundary identified by the previous
[real-tool learning study](learning-storage.md). It reuses Namzu’s skill approval
hash, agenda revisions, prompt contribution registry and existing CLI session
path. It does not add another agent loop, infer source dependencies from prose,
or establish autonomous selection of learning objectives.

## What changed

Optional host-owned source bindings are part of a candidate’s approval identity.
An exact dependency match permits projection; a changed or unavailable dependency
withholds the skill body while retaining its historical record. Bound instructions
are reconsidered for every provider request instead of remaining in the standing
prompt. A real SDK query test changes the source revision inside a tool execution
and verifies that the next provider request contains the withholding notice and
no old instruction body. Immutable persistence, round trips, baseline capture and
rollback retain the bindings.

The default CLI resident profile resolves workspace-file SHA-256 dependencies
with bounded local observations. Unknown namespaces, symlinks, missing files,
non-regular files and oversized files remain unverified. The fixed-snapshot
interactive resident profile withholds bound skills. Undeclared dependencies and
ordinary unbound guidance still need task-level evidence checking. This feature
is not automatic factual correctness or a transactional filesystem guarantee.

## Targeted real CLI observations

`node research/resident/source-bound-live.mjs --live` uses isolated state and
Muse Spark 1.3 Contributor Free at low effort. Its promotion evidence is explicitly
**scripted** to exercise an already-approved skill, not measured improvement.
Each admission runs through the actual built resident CLI in a new process.

| Dependency | Guidance projected | Observed result |
| --- | --- | --- |
| Original routing map | Yes | `SOURCE_A_READY`, complete |
| Map now selects another file | No, changed-source | `SOURCE_B_READY`, complete |
| Map removed | No, unverified-source | `SOURCE_UNAVAILABLE`, blocked |

Rollback was committed and reopening showed no active skill. All three receipts
settled, recording 69,080 unpriced tokens. [Receipt](results/2026-09-14-source-bound-cli.json).
The provider-generated result agrees with the fixture values; scripted promotion
must not be relabelled as a live learning acceptance result.

## Actual TUI, external edits and resume

A 120×32 PTY launched the built CLI with an isolated `NAMZU_HOME`, selected Muse
and `/effort low`, and used normal keyboard input. No personal state or credentials
were copied. The first prompt asked it to read the file selected by routing.json.
Between turns, the test operator changed that map outside Namzu.

The first result was `SOURCE_A_READY`. The next short follow-up received a provider
`refusal` finish without confirmed usage; the runtime retained one unresolved
request and the UI incorrectly reported exhausted token allowance even though all
configured caps were zero. The stop formatter now distinguishes unavailable usage
from actual allowance exhaustion. A real App terminal-rendering regression feeds
that captured budget shape and verifies the correct notice and usable composer.
This fixes the explanation, not the underlying provider refusal or missing receipt.

A fresh explicit observation then returned `SOURCE_B_READY`. After another external
map change, the short question `Simdi guncel deger ne?` read the new source and
returned `SOURCE_C_READY`. The CLI was cleanly exited; the selected file’s bytes
were changed from C to D, then the same conversation was reopened with `resume`.
After selecting low effort again, the identical short question returned
`SOURCE_D_READY` from a successful read. Both PTYs exited cleanly.

The [retained receipts](results/2026-09-14-source-freshness-tui.json) include each
run, exact tool input/output, transcript digest, config and final usage state.
They record 183,275 tokens and one unresolved request, so this is a lower bound.
This verifies ordinary conversation freshness and reopening; it is a separate
observation from the source-bound resident integration above. There is no claim
that every repeated repaint in PTY output is a duplicated screen row.

## Fresh real-tool learning evaluation

The v2 grader was declared before this run. It accepts an exact value actually
returned by a successful read window or a search result attributed to the exact
current source. Wrong files, unrelated read windows, near matches, failed tools
and unfinished tasks do not pass. Normal completed failures with settled usage
no longer masquerade as unknown spending. Interrupted or unresolved requests
remain unknown. Historical v1 scores were not rewritten.

The scripted control exercised verification, fresh confirmation, activation,
reopening and rollback with 78 tool-using SDK runs and zero model calls.
[Control audit](results/2026-09-14-tool-learning-v2-control.json).

The new Muse/low study made 47 SDK runs and recorded 461,649 unpriced tokens:

| Verification arm | Exact answers | Passing complete, grounded tasks | Normally ended |
| --- | --- | --- | --- |
| Frozen | 2/10 | 1/10 | 6/10 |
| Raw experience | 9/10 | 9/10 | 9/10 |
| Generated guidance | 8/10 | 8/10 | 8/10 |

Three timed-out verification runs retained unresolved usage. The cycle therefore
remained **inconclusive**, without fresh confirmation or activation. Its review
also recorded regression/inconclusive evidence on one family. A successful gate
was not manufactured by retries or substituting fabricated measurements. Four
holdouts gave frozen 2/4, memory 4/4 and guidance 4/4. Current guidance handled the
changed-map control; stale and irrelevant unbound guidance both returned wrong
values in their single controls. [Live audit](results/2026-09-14-tool-learning-v2-muse.json).

Case concurrency was two; separate targeted CLI and TUI observations overlapped
on the same provider. Timing and timeout outcomes therefore cannot support an
isolated throughput or latency comparison. Guidance does not outperform raw
experience on this evidence. Independent confirmation and a live activation of
a genuinely accepted real-tool candidate remain pending.

The three live exercises together recorded **714,004 tokens**, including failed
work; unresolved usage makes this a lower bound. No monetary saving is claimed.

## Checks and remaining work

Workspace typecheck, lint, build and all unit tests passed: SDK 6,874, CLI 3,116
(five skips), plus all other workspace packages. The research evidence tests
passed. Documentation conformance, compiled fences and public signature checks
passed. Existing lint warnings remain. These are development checks, not a claim
that every release gate or an npm publish has completed.

Next evidence should isolate provider load, predeclare adequate per-case time
allowances, and retain failures and resource uncertainty. It must preserve the
same independent confirmation/activation gate; no automatic learning promotion
or change to the default unlimited CLI run policy follows from these results.
