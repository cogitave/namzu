# Resident wake evidence — 2026-09-12

At `ea5367de`, two accepted wake inputs overwrote the same `reason` field. An
SDK reproduction submitted `Build failed: BUILD-ALPHA`, then
`Security passed: SECURITY-BETA`, reopened the agenda and rendered the admitted
continuation. The first receipt was absent; only the second reached context.
No inference was used to establish that data loss.

The fix retains a bounded immutable batch through admission, then consumes it
with successful settlement. The latest reason is not repeated separately when
the batch is projected. The host's summary must retain facts that remain useful
afterward; this does not implement full episodic recall.

The [CLI reproducer](wake-evidence-cli.mjs) creates a temporary home and workspace.
Every add, wake, status and run command uses a separate real CLI process. It
asserts two retained inputs and their order before invoking a model. Default
mode performs only these local control operations; live mode additionally runs
one read-only admission, checks its decision and reopens terminal work.

```bash
pnpm -r build
node research/resident/wake-evidence-cli.mjs
node research/resident/wake-evidence-cli.mjs --live
node research/resident/wake-evidence-cli.mjs --live --interactive
```

Both final live runs used Zen's `muse-spark-1.3-contributor-free` at low effort,
one admitted step, at most three iterations and a 30,000-token cap. Both summaries
retained BUILD-ALPHA as failed and SECURITY-BETA as passed; both returned
`blocked` because release required both checks to pass. Cleanup was confirmed,
the pending batch was consumed, and a subsequent CLI run admitted no new step.
Resident and interactive profiles reported 4,791 and 5,980 total tokens
respectively. One earlier resident-profile smoke also passed before duplicate
latest-reason context was removed; it reported 4,880 tokens. These were three
live admitted steps, with no semantic retry of a failed outcome.

[Recorded results](results/2026-09-12-wake-evidence.json) include final source and
build fingerprints. Usage was unpriced, so the recorded zero cost does not
establish a measured monetary cost or saving. This small synthetic regression
checks that accepted inputs reach inference and survive reopening; it is not
a general memory, quality, model comparison or intelligence benchmark.

Separate SDK tests cover both standalone and agenda storage: conflicting writers,
retry of rejected inputs, immutable capture, count/character overflow without
revision changes, failed settlement and explicit reconciliation. Real process
tests also retain the batch after the owning process exits and after an agenda
worker is killed following a file effect. Reopening does not replay the effect;
inspected settlement consumes the batch. Prompt tests retain both inputs after
compaction and verify that the latest input appears once.

No TUI surface changed in this experiment. CLI `resident status` displays a
pending input count and JSON status retains the complete batch. Running claims
still reject incoming wakes; this is not an implementation of mid-step steering.
