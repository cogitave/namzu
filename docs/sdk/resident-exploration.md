---
type: Reference
title: Environment exploration before learning
description: Optional active tool experiments, retained observations and independently evaluated guidance without a supplied correction.
resource: packages/sdk/src/manager/resident/learning-cycle.ts
tags: [sdk, resident, learning, exploration]
status: draft
---

# Environment exploration before learning

The optional `ResidentLearningCycleOptions.explore` callback runs before
`generate`. It can use the normal SDK runtime and host-authorized tools to let
the model choose experiments and observe their consequences. No correction text
is required. Hosts that omit it retain the existing direct-generation path.
The runtime does not automatically install an explorer in ordinary chat.

`ResidentLearningExplorationContext` provides the original failure, active
baseline, skill name, cancellation signal and usage recorder. The host mounts
the available environment operations; the model chooses their inputs through
ordinary tool calls. Host callbacks must retain actual outputs separately from
the model's interpretations. Tool authority and environment integrity remain
host responsibilities, just as in a normal SDK run.

The callback returns `{ observations: { evidence, trace }, usageComplete }`.
Evidence uses `ResidentLearningEvidence`; trace is nonempty and bounded to
32,000 characters. The cycle validates, copies and freezes these observations,
persists an `exploration` event with a SHA-256 digest, and only then exposes them
to `generate` through optional `context.exploration`. The original failure is
preserved. Labels and a digest establish identity, not the truth of a host's
arbitrary trace. Retain the source tool transcript for independent inspection.

`ResidentLearningStage` includes `explore`. Its stage and usage events share the
existing ordered journal and resource accounting. Incomplete, unpriced
cost-limited or exhausted exploration stops before generation. Cancellation,
agenda revision conflicts and journal failures do not turn partial experiments
into accepted guidance. Every execution needs a non-overlapping receipt,
including failed probes and side calls; callbacks enforce in-flight limits.
There is no automatic replay after interruption.

The predeclared preservation plan and held-out evaluation tasks are never passed
to exploration or generation. Verification, fresh confirmation and exact-revision
activation still use the existing [learning cycle](resident-learning-cycle.md).
Hosts must keep hidden cases out of the tools and filesystem visible to both
callbacks. The SDK cannot authenticate independence from a task label alone.

The [CLI learning host](../cli/resident-work.md#explicit-learning-experiments)
forwards `explore`, shows an environment-exploration phase, and stores the
observations in its SQLite event journal. The source-backed experiment under
`research/resident/autonomous-learning-study.mjs` exercises model-selected
black-box probes, generated guidance, raw-experience controls and fresh-task
evaluation. Its scripted mode checks execution only; live mode selects Muse low.

This capability supports learning from environment feedback. It changes retained
instructional guidance, not model weights or the improvement procedure itself.
Neither enabling a callback nor passing a small experiment establishes RSI,
general intelligence, or autonomous assessment of arbitrary user work.
