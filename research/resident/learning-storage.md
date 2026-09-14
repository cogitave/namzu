# Durable learning: storage and real-tool evaluation

This milestone connects the existing resident learning cycle to durable, scoped
records and an explicit CLI execution path. It does not create a second inference
engine, train weights or demonstrate recursive improvement of the learner itself.
The implementation is optional; opening ordinary chat does not start experiments.

## Source-backed storage decision

The user identified [openai/codex](https://github.com/openai/codex). Sources were
read at revision `6f39a47bb3b04de4c804187bfbf55edc56939aab`; a content-hash manifest
is retained with this report. We did not infer Codex's design from the appearance
of a personal home directory.

Codex's state crate describes extracting metadata from JSONL rollouts. The
current runtime also owns goals, memories and a durable user-message queue;
logs and paginated history use dedicated databases to reduce contention. Thus
“SQLite is only a disposable transcript index” would be an incomplete reading
of this revision. Its memory runtime includes extraction and consolidation work,
not merely a folder of notes. Sources: [state crate](https://github.com/openai/codex/blob/6f39a47bb3b04de4c804187bfbf55edc56939aab/codex-rs/state/src/lib.rs),
[current runtime](https://github.com/openai/codex/blob/6f39a47bb3b04de4c804187bfbf55edc56939aab/codex-rs/state/src/runtime.rs),
[memory runtime](https://github.com/openai/codex/blob/6f39a47bb3b04de4c804187bfbf55edc56939aab/codex-rs/state/src/runtime/memories.rs).

Codex opens writable pools with WAL, normal synchronization and a five-second
busy timeout, and has a separate read-only opening path. Its configuration
reference exposes `sqlite_home` for resumable runtime state. Namzu reuses the
separation between authoritative records, queryable state and large retained
content, while keeping short rollback-journal transactions for this explicit
local experiment workload. We have not measured a throughput advantage over WAL.
Sources: [SQLite configuration](https://github.com/openai/codex/blob/6f39a47bb3b04de4c804187bfbf55edc56939aab/codex-rs/state/src/sqlite.rs#L297),
[official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

| Namzu data | Location and authority | Reason |
| --- | --- | --- |
| Project/root bindings and Sessions | Existing `state/sessions.sqlite` | Indexed ownership; no per-project registry directory. |
| Learning events, parent links, status and usage | New `state/learning.sqlite` | Event and projection commit together; bounded scoped queries. |
| Large evaluation batches and host traces | New `learning/artifacts/<sha256>.json` | Immutable complete JSON, authenticated by DB references; no growing JSON array per cycle. |
| Accepted guidance and exact activation evidence | Existing resident agenda | Preserve its compare-and-swap and rollback contract. |
| Execution transcripts | Existing RunStore | Preserve original execution evidence and its ownership. |

The SQLite learning journal is **authoritative**, not a cache reconstructed from
artifacts. Derived JSONL exports are not another writable ledger. Publishing an
artifact precedes its reference; a crash can leave an unreferenced blob. An
activation acknowledgement and a final learning event live in different stores:
a missing final event requires inspecting the agenda's evidence key and hash,
never automatic replay. These are explicitly documented recovery boundaries.

SDK consumers use `SqliteResidentLearningStore` and
`runStoredResidentLearningCycle`. The CLI uses `resident learn <host.learning.mjs>`
and read-only `resident learning [cycle-id]`. The selected module is executable
host code with normal SDK callbacks. It owns its provider choice, permissions,
scoring and bounded I/O; trust admission does not sandbox that module. This
follows the existing local eval-suite convention and keeps a provider-specific
learner out of the kernel. See the [SDK contract](../../docs/sdk/resident-learning-storage.md)
and [CLI contract](../../docs/cli/resident-work.md#explicit-learning-experiments).

## Why these evaluation controls

GEPA motivates using execution feedback to propose instruction changes and
checking them on held-out evaluations. We use proposal/evaluator separation and
fresh confirmation, not its complete search algorithm, and make no claim to
reproduce its results. [GEPA](https://arxiv.org/abs/2507.19457).

PAST-Bench distinguishes persistence-enabled episodes from fresh-context and
cold controls, and tests whether stale, irrelevant or mismatched retained
material changes performance. This motivates separate raw-memory, generated-
guidance and misleading-guidance conditions. Our constructed file workspaces
are not its published benchmark and do not establish general continual learning.
[PAST-Bench](https://arxiv.org/html/2608.04003v1).

## Reproduction and measurement boundaries

Build the workspace, then run:

```bash
node research/resident/tool-learning-study.mjs
node research/resident/tool-learning-study.mjs --live
node research/resident/tool-learning-audit.mjs /absolute/path/namzu-tool-learning-result
```

The first command scripts inference but uses real SDK file tools, SQLite,
artifacts, CLI processes and agenda activation. It verifies plumbing only. The
live variant explicitly uses Zen `muse-spark-1.3-contributor-free`, low effort.
It never uses Luna or mutates personal residents. Each run creates an isolated
application home and small synthetic workspaces under the system temporary
folder. Paths in evidence identify those fixtures, not a user's private files.

Each fixture has stale documentation and a current source selected through a
hidden authority map. The host supplies the convention after a cold failure;
this is deliberately acquired workspace knowledge, not a model independently
discovering a universal rule. Five task families each have two paired trials in
verification and fresh confirmation. Frozen, raw-experience and generated-
guidance arms start with fresh histories and execute the same read/glob/grep
surface. Arm order reverses between rounds, but this remains a small unblinded
experiment, not a randomized causal estimate.

The grader checks an exact value and an actual successful read of the current
source. Candidate generation receives only the seed trace and host correction,
not confirmation fixtures or expected answers. Four novel workspaces follow the
acceptance rounds. The authority-map update control retains the old source while
pointing to a new one; irrelevant and stale guidance are separate observations.
After accepted activation, another CLI process executes a resident step; rollback
removes the guidance and a fresh SDK run observes the resulting behavior.
A resident's own completion claim is not itself the external correctness check.

Every owned evaluation and generation receipt is charged to the cycle, including
the raw-memory control. Cold, holdout, later controls and CLI admission are
reported separately and included in total recorded overhead. Unknown prices
remain unknown, even though the model name contains “free”. An unfinished run
has recorded lower-bound usage and cannot establish complete consumption.

## Recorded observations

The result artifacts and final validation notes below distinguish the initial
resource-limited experiment from the subsequent equal-budget measurement.

### Storage flaw found and corrected during measurement

The first runs exposed that `runAgent` did not forward the kernel's existing
`pathBuilder`, `runStore` or `checkpointStore` options. Its default generated
`.namzu` state inside the tool workspace, and hidden-file searches could encounter
prior run records. A fresh message history alone did not provide independent
filesystem conditions. The second exploratory run was stopped after identifying
this confound; both exploratory artifacts remain retained and excluded from the
quality comparison below.

The additive SDK fix forwards those three existing controls. A real-tool
regression checks both external disk paths and injected in-memory stores, and
asserts that the working directory contains only its original file. The final
study uses an external builder and checks after every case that no `.namzu`
directory was created in its fixture. This deliberately preserves existing SDK
defaults while enabling a host to choose a correct layout; CLI storage remains
in its application home.

### Final isolated Muse measurement

The [read-only audit](results/2026-09-14-tool-learning-muse.json) verified all 35
artifact hashes, 39 ordered events and 31 distinct cycle receipts against the
underlying run records. No generated state appeared in the measured fixtures.
The experiment used 18,000 observed tokens, eight iterations and 45 seconds per
SDK case, with a declared 800,000-token cycle policy. These caps do not guarantee
that a request whose measured usage arrives later cannot exceed an estimate.

| Verification arm | Exact answers | Original exact-answer-plus-`read` gate | Settled runs | Recorded tokens |
| --- | --- | --- | --- | --- |
| Frozen | 2/10 | 2/10 | 7/10 | 136,687 |
| Raw experience | 10/10 | 10/10 | 10/10 | 99,948 |
| Generated guidance | 10/10 | 9/10 | 10/10 | 56,796 |

The ninth gate score is a **grader limitation**, not an incorrect tenth answer:
the guidance run read the authority map and used `grep` on the exact current
source. Its returned value was correct. The predefined gate demanded `read`,
so it rejected a valid alternative. We retain that original score instead of
rewriting the acceptance result after seeing it. A later evaluation should
predeclare evidence semantics that admit both exact reads and scoped search.

Guidance and raw experience had equal answer accuracy; guidance used about
43% fewer recorded tokens in these ten cases. This is descriptive and excludes
its proposal/evaluation cost. It does not establish a general advantage over
retrieval. Four novel workspace observations gave frozen 2/4, raw experience 4/4
and guidance 4/4. The changed-map control was correct with current guidance;
irrelevant guidance was also correct on that single case. Stale guidance returned
the stale value. Thus these data do not show that irrelevant guidance is harmless
in general, and do show a concrete anchoring failure for stale material.

The learning result was **inconclusive**. Three frozen verification runs stopped
on token or iteration limits, leaving consumption completeness unknown under the
host's conservative accounting rule. The SDK retained the candidate but admitted
neither confirmation nor activation. Holdout/control observations explicitly used
the unactivated candidate; they cannot be relabelled as evidence that an accepted
resident skill ran. No live rollback or post-activation resident step was performed
in this study. The [scripted control](results/2026-09-14-tool-learning-control.json)
exercised those state transitions; the earlier [text-routing study](learning-cycle-results.md)
contains a separate live activation/reopen/rollback observation.

### Transport defect and targeted verification

One frozen holdout reached time/budget finalization and received HTTP 400 because
the Muse endpoint accepts only automatic `tool_choice`. Namzu had sent `none`.
The Zen Responses adapter now represents a no-tools turn by omitting both tool
definitions and tool choice. Required/named choices remain explicit. This keeps
the requested no-tools meaning without assuming every Responses upstream accepts
OpenAI's complete parameter menu.

Four wire regressions passed. A [targeted live probe](results/2026-09-14-zen-finalization.json)
sent one Muse/low request with tools disabled, observed no tool definitions or
tool-choice field on the wire, and received `ready`. A separate ordinary built-CLI
run also returned `ready`, exit 0. The latter is a normal CLI smoke check, not a
claim that it traversed forced finalization. The full learning benchmark was not
rerun after this transport fix; its HTTP failure remains in the recorded results.

```bash
node research/resident/zen-finalization-probe.mjs --live
```

### All recorded live overhead

| Execution | Recorded tokens | Interpretation |
| --- | --- | --- |
| [Initial 6k experiment](results/2026-09-14-tool-learning-limited.json) | 191,190 | Resource-limited and contaminated; producer also failed to handle absent learning state. |
| [Stopped 18k experiment](results/2026-09-14-tool-learning-contaminated.json) | 173,029 | Stopped on discovery of workspace-state contamination; excluded from quality evidence. |
| Final isolated experiment | 449,502 | 47 SDK runs including cold, proposal, all measured arms, holdout and controls; five unfinished executions overall. |
| Targeted transport and CLI smoke | 7,905 | 97 provider tokens plus 7,808 recorded CLI tokens. |
| **Total** | **821,626** | Recorded lower bound, including discarded work; no monetary saving is claimed. |

All study tokens were unpriced in Namzu. The direct provider probe has no pricing
receipt. The CLI smoke's reported 7,808 tokens exceeded its 6,000-token configured
budget in one completed request; this exposes the distinction between runtime
admission estimates and a vendor's eventual measured usage. Provider-side request
ceilings and reservation calibration require their own experiment before a host
can claim a strict token-spending guarantee.

The SQLite cycle's 240,385 known tokens exclude three receipts marked unknown;
that conservative total is not the experiment's complete recorded overhead.
Using it alone for a performance or cost claim would hide failed work.

## Validation and next evidence needed

Workspace type checking, lint, builds and tests were run, along with SDK process
regressions, coverage/floors, documentation checks/fences, export/test-presence,
publish metadata, source-name/log audits and local evals. Linux process tests
include conflicting concurrent writes and abrupt death inside an uncommitted
SQLite transaction. They do not establish Windows power-loss durability.

The next quality experiment should accept correctly scoped search as evidence,
separate completed failure from missing accounting, and compare retrieval versus
compiled guidance on repository tasks with calibrated run ceilings. A successful
independent confirmation must precede actual activation. Automated objective
selection, recursive modification of the learner, broad transfer and AGI remain
unestablished.

Final test counts were SDK 6,862, CLI 3,058 (five skipped), Zen 124 and SDK process
268. One workspace invocation hit an existing foreground-process test's worker
loader error (`encodeCodeValue` export unavailable). Its isolated five-test suite
and the complete CLI suite subsequently passed without changing that source.
The transient loader failure's cause was not established. No publish or consumer
registry-install claim is made by these local results.

## Source-validity follow-up

The [source-freshness follow-up](source-freshness.md) adds optional revision-bound
guidance, rechecks it per model request, and records real resident CLI and TUI
observations, including external edits and conversation reopening. Its new
read/search-aware learning evaluation remains inconclusive; the recorded failures
and absence of real-tool activation are preserved.
