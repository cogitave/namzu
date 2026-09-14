# Explicit unlimited execution — 2026-09-14

The user requested optional limits with accurate usage accounting. Inspection
at `2869fbec` found the token ledger already understood zero as unlimited, and
the CLI already gave unlimited children zero-token accounts. The CLI config
reader and headless flags nevertheless rejected zero. Independent hardcoded
iteration/time guards also prevented expressing an unlimited run through config.

The change accepts zero for `limits.tokenBudget`, `limits.maxIterations` and
`limits.timeoutMs`. Zero token/iteration flags override finite configuration.
The SDK gives iteration/time zero the same meaning. At that milestone, omitted defaults stayed as
before; the subsequent default-policy change is recorded below. Built-in children receive explicitly configured limits; specialists
keep their own iteration settings. The existing ledger continues to own
accounting, inheritance, request receipts and cold recovery. No second ledger
or admission estimator was introduced.

This changes the SDK meaning of explicit zero iteration/time values, and makes
configured CLI iteration limits apply to built-in children. Both changes carry
major changesets with migration instructions. No release was published here.

## Evidence

[Recorded live receipts](results/2026-09-14-muse-low.json) contain only isolated
fixture results and usage. All live calls used Zen
`muse-spark-1.3-contributor-free`, low effort.

| Surface | Task | Recorded tokens | Outcome |
| --- | --- | ---: | --- |
| Built CLI, zero config | Read a one-line file and answer | 16,048 | Two iterations, normal completion, unlimited ledger |
| Built CLI, finite config overridden by zero flags | Same file task | 15,947 | Two iterations; both configured caps removed |
| Interactive TUI, 120×32 PTY | `/effort low`, read the file and answer | 21,215 | Normal completion, all three effective limits zero |

Total recorded live usage: **53,210 tokens**. No monetary cost claim is made.
These short calls establish integration behavior, not hours of autonomous
progress. The live headless probe is reproducible after building:

```bash
node research/run-limits/live-cli.mjs --live
```

The script creates an isolated application home and workspace. Its external
90-second process timeout bounds the probe without changing product run limits.
The manual TUI test used that same isolated workspace and a fresh conversation;
it did not modify personal resident state or credentials.

The TUI test also exposed a separate display defect: the stored/model answer was
`RUN_LIMITS_READY`, but inline underscore emphasis rendered `RUNLIMITSREADY`.
The parser now preserves identifier underscores, including Unicode names.
Reopening the exact conversation in the rebuilt TUI displayed `RUN_LIMITS_READY`
without another model call (two run records before and after reopening).

Deterministic regressions exercise the real runtime with scripted inference:

- 53 requests and 52 tool executions in one unlimited run, retaining simulated
  usage of 5.3 million tokens; finite iteration/token variants stop correctly.
- Two concurrent CLI children, each completing 43 requests and retaining
  430,043 simulated tokens, without the previous 40-iteration child default.
  Explicit two-iteration variants stop as incomplete.
- Cold ledger reopen with 300,000 previous tokens, 500 iterations and 24 hours
  of saved elapsed time; the next request finishes and the ledger records
  300,050 tokens. These time/usage values are fixtures, not a day-long soak.
- Unlimited sandbox acquisition and cancellation while acquisition is stuck;
  infinite remaining time never reaches a platform timer.
- User/project config precedence, headless flags, interactive bootstrap/resume,
  delegation construction and admitted resident-step forwarding.

The initial parallel-child fixture lacked a review handler and correctly
cancelled at tool review. It now explicitly approves its inert observation
tools; no permission behavior was weakened. Two older SDK tests used zero
iterations to prohibit admission. They now test pre-admission cancellation and
an actually exhausted inherited token account; positive iteration exhaustion
remains covered independently.

## Remaining boundaries

Finite token budgets still admit against measured usage. A provider receipt can
exceed its remaining allowance; this work does not turn that policy into a
provider-side billing cap. Unresolved receipts and accounting failures retain
their existing handling. Cancellation, permissions, context management,
per-request output limits and stream/tool liveness checks stay independent.
Resident lifetime accounting does not impose a hidden lifetime spend limit;
run limits apply per admitted SDK step.

Validation: workspace typecheck, lint, build and unit tests; SDK process tests;
documentation conformance and compiled fences; workflow parity, project
references, public signature exports, SDK test presence and publish metadata.
The full workspace suite passed with 6,870 SDK tests and 3,082 CLI tests (five
CLI skips). The subsequently added resident unlimited-forwarding case passed
with its complete 57-test file. Local lint retains existing warnings. Publishing
checks are separate from these development checks.


## Follow-up: unlimited defaults and `/config`

The next user request made unlimited execution the CLI default, with limits
editable through `/config`. Main and built-in child runs now default to zero
for all three guards. SDK embedding defaults stay separate. Session edits are
captured per new run and forwarded to its built-in children; a parked CLI run
reloads its own scoped metadata. The picker does not rewrite config files.

[New recorded receipts](results/2026-09-14-defaults-and-config.json) cover real
Muse low calls, separately from the earlier 53,210-token milestone:

| Surface | Effective settings / action | Iterations | Tokens | Result |
| --- | --- | ---: | ---: | --- |
| TUI, no limits configured | Read and answer | 2 | 21,260 | Completed |
| Same TUI, model turns edited to 1 | Read again | 1 | 12,340 | `max_iterations`, displayed as a stopped run |
| Same TUI, remove all caps | Read and answer again | 2 | 24,599 | Completed |
| Same TUI, 100,000 tokens and 30m | One-line answer | 1 | 12,802 | Completed; both caps recorded |
| Headless, no limits configured | Read and answer | 2 | 15,940 | Completed, all guards zero |

New live usage totals **86,941 tokens**. UI changes make no model requests.
The terminal used an isolated home/workspace at 120×32. `/config` opened a
Run limits row, each limit was editable, Esc cancelled an uncommitted edit,
and all four actual TUI runs retained their measured receipts. The external
headless probe is reproducible with `node research/run-limits/live-cli.mjs
--live --defaults-only`; omitting `--defaults-only` also runs the earlier
explicit-zero config and flag cases.

Deterministic CLI regressions cover default children exceeding 40 calls,
per-parent overrides removing all three finite launch caps, finite iteration
stops, value validation, the real App picker-to-send path, and paused-run
reopening with recorded finite/unlimited limits and scope mismatch refusal.
No long-running soak, provider quota removal, or strict billing cap is claimed.


Follow-up validation: workspace typecheck, lint and build passed; documentation
conformance/fences and signature exports passed. The CLI suite passed **3,112
tests, five skipped, across 343 files** with four workers. Earlier default-worker
runs exposed a timing-sensitive existing goal-status screen assertion; its
12-test file passed independently and the full four-worker run passed without
changing that goal test. New picker tests wait for visible state before typing.
The workspace run also passed the SDK's 6,870 tests and the other package suites.
No release/push or complete release-gate claim is made by this record.
