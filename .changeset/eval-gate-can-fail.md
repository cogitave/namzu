---
'@namzu/cli': minor
---

The behaviour gate can go red.

Three things stood between `namzu eval` and being a gate, and each one made it report success.

**It exited 0 when a suite never settled.** The promise stayed pending, node's event loop drained, `process.exit` was never reached, and the process ended on its default code. A gate that reports success by hanging is worse than no gate, because the green tick is what stops anyone from looking. Each suite now runs against a deadline (`--timeout-ms`, default five minutes) and a suite that overruns is **inconclusive** — exit 2 — with a message naming it. Inconclusive rather than failed, matching the rule the exit codes already state: nothing was judged, so there is no regression to chase, there is a harness to fix.

**CI invoked the wrong file.** The step ran `packages/cli/dist/index.js`, which is the package barrel and not the CLI, so it executed nothing and passed on every push since it was added.

**There were no suites.** `evals/` is now a private workspace member with a first suite, and `continue-on-error` is gone from the CI step — its own comment said to drop it the moment a suite existed, or the gate is decoration.

The first suite pins loop behaviour against a scripted provider: a turn with no tool calls settles on its text, every call in one turn runs in the order it was issued, a failing tool goes back to the model instead of killing the run, and a forced tool choice applies to the step that asked and no further. Nothing there measures a model — the turns are fixed, so a score that moves means the kernel changed. A suite that calls a real provider measures two things at once and cannot say which one moved; those belong behind a tag.
