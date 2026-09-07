# A bounded CLI work fixture

Dispatch Desk is a small in-memory job queue with an injected clock. It exercises
inspection, code changes, regression tests and a later change of requirements.
The fixture has six source files, two JSON fixtures and two test files containing
12 visible behavior tests. It requires Python 3 for generation and Node 24 for
execution; there are no package installs, services or network dependencies.

These assets support an operator-run experiment. Nothing here starts a model,
changes CLI settings or consumes provider credits. The intended workload is
roughly 15–30 useful tool/model interactions, not a required minimum. Do not add
polling, repeated narration or artificial context padding if a model finishes
sooner.

## Generate and verify the fixture

From the repository root:

```bash
fixture_dir="$(mktemp -d)"
python3 research/cognition/long-work/build-fixture.py "$fixture_dir"
python3 "$fixture_dir/private/make-reference.py" "$fixture_dir"
node "$fixture_dir/private/preflight.mjs" "$fixture_dir"
```

The generator requires an existing empty directory, rejects a symlink as its
output directory and checks user ownership where supported. It refuses to
overwrite existing work. The reference constructor also refuses existing
reference directories. A failed generation may leave partial files: use a new
empty directory rather than overwriting that directory.

The output has two sibling directories:

- `workspace/`: the model's working directory, visible requirements, historical
  distractor notes and application/tests.
- `private/`: the evaluator, immutable-file hashes, untouched baseline, optional
  reference solutions and preflight results. Keep this outside the model's
  allowed filesystem roots when the host supports confinement.

Copying the evaluator outside the working directory is not an operating-system
security boundary. Do not present this fixture as an adversarial isolation test.
Do not expose private failures or reference patches during a purported blind
run. The generated evaluator and reference scripts are self-contained and can
be used after the repository checkout moves.

Preflight requires these exact baseline/reference outcomes:

| Copy | Visible tests | Hidden tests |
| --- | --- | --- |
| Untouched baseline | 8 pass, 4 fail | 3 pass, 5 fail, 7 steering tests skipped |
| Base reference | 12 pass | 8 pass, 7 steering tests skipped |
| Steered reference | 12 pass | 15 pass |

Four seeded defects concern tenant/key identity, the total-attempt limit,
finish-based retry scheduling and cumulative handler time. Correct behavior also
requires terminal idempotency, detached snapshots, bounded batches and isolated
failures. The private references demonstrate a small solution; they are not the
only accepted implementation.

## Operator prompts and timing

Run the chosen CLI from `workspace/`, with provider configuration and observation
artifacts outside it. The fixture itself does not prescribe a model, effort,
context override or token budget. Record all of those experimental conditions.

Initial prompt:

> Repair Dispatch Desk's tenant isolation, retry scheduling and work-time
> accounting against REQUIREMENTS.md. Read the requirements first, inspect the
> implementation and run the tests. Keep all existing tests, fixtures and public
> exports; add focused regression tests. Use only the injected clock and Node
> builtins, no installs/network. Work only in this project directory. Finish with
> a concise explanation and the exact validation result.

Send this extension after the first source edit or test-driven diagnosis and
before the initial turn finishes, if testing in-flight steering:

> New operator requirement: add cancel(tenant,key). Queued or retrying jobs become
> cancelled and never run again. A running job becomes cancelled immediately, but
> its actual handler must finish and its duration/history must still be recorded;
> late success or failure must not overwrite cancelled or schedule a retry.
> Return true only on the first cancellation of a queued/retrying/running job;
> unknown, already-cancelled or terminal jobs return false. Cancellation is sticky
> under duplicate enqueue and affects only that exact tenant/key. This supersedes
> the old note that cancellation is out of scope. Keep every earlier constraint
> and regression. Add tests, including cancellation while a handler is awaiting
> a controllable promise; use no real sleeps.

Send the later regression request while that work is active:

> Before closing, check the current cancellation contract again: a running
> handler may fail after cancellation, and duplicate enqueue must still retain
> that cancelled record. Add a regression proving both while a second tenant
> with the same key still succeeds. Preserve exact total-attempt limits and
> finish-based retry timing, rerun the complete suite, and report actual results.

Record enqueue and consumption boundaries for both messages. If a prompt arrives
after a turn completes, label it a subsequent user turn rather than evidence of
in-flight steering. A compaction notification alone does not establish that the
next provider request was smaller or preserved the latest requirement.

## Validation and grading

The visible validation command, executed in `workspace/`, is:

```bash
node --test test/*.test.mjs
```

The operator grades from outside the model session:

```bash
node "$fixture_dir/private/grade.mjs" "$fixture_dir/workspace" steered "$fixture_dir/final-grade.json"
```

Use `base` instead of `steered` only before the cancellation extension. A pass
requires all visible tests (including additions), all phase-appropriate hidden
tests, unchanged protected files and no prohibited-source flags. The evaluator
checks registered test counts so an early successful process exit is not a pass.
Protected hashes cover the supplied tests, fixtures, package metadata and
requirements. The source-pattern check is supplemental; it is not a complete
static analysis of network, timing or subprocess use. Review the final diff too.

For reproducible comparisons, record the fixture revision, model/effort, actual
requests and reported tokens, tool execution results, steering boundaries,
compaction behavior, stop reason and final grading. A budget-induced pause is an
incomplete bounded run. A model claiming success while behavior tests fail is a
different outcome. Keep credentials and full provider/terminal recordings in
private operator storage; do not commit them here.

## First observed live run

[first-live-run.json](first-live-run.json) records one CLI run using
`gpt-5.6-luna` at `low`, a 16,000-token context override and a 250,000-token
operator guard. It made **25 requests and reported 255,835 tokens**. The in-flight
request crossed the guard; subsequent generation was stopped and surfaced as a
network-classified pause. This was an induced stop, not an observed outage.

At that stop, **16 of 17 visible tests and 12 of 15 hidden tests passed**. Protected
files were preserved. Remaining failures concerned cancellation during an active
handler and retention of its actual outcome/accounting. The first cancellation
instruction was a second user turn after initial repair finished; the later
regression request was consumed as steering during the cancellation turn.

This is an interrupted result from one task and one configuration. It establishes
neither a causal effect of compaction/steering nor a general capability score.
The reference preflight shows that the requirements are jointly satisfiable; it
does not predict how reliably another model or run will satisfy them.

The [conversation resume](resume-live-run.json) made another six requests at the
same model and effort, reporting 65,139 tokens. It reached 17/17 visible tests and
claimed completion, while independent checks remained 12/15. Actual attempt
success/failure was still replaced by cancelled and failure text was absent.
No private failures were supplied to the model. This exposes a completion-quality
gap and successful conversation restoration, not a causal before/after comparison
or proof of exact checkpoint retry. See the [source review](../PYDANTIC_REVIEW.md)
for the distinction between production behavior and the proposed executive.
