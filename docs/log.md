# Documentation update log

## 2026-09-02
* **Creation**: [Context and compaction in the CLI](/cli/context-and-compaction.md) — the file-only `compaction` key and the `/context` command.
* **Update**: [The salience-scored working set](/sdk/salience-working-set.md) — phases 1–4 landed: scoring core, goal vector, working-set eviction, soft trigger; `strategy: 'salience'` is selectable.
* **Creation**: [The salience-scored working set](/sdk/salience-working-set.md) — the plan that makes per-message scoring and a dynamic context real; six phases, each with what it must prove.
* **Creation**: [The review policy](/sdk/review-policy.md) — the permission modes moved from the operator application into the kernel as `createReviewPolicy`.
* **Initialization**: `docs/` became an empty OKF v0.2 bundle. The pages written under the previous documentation standard were removed rather than migrated; a page returns when the code it describes is next touched, written to the bundle's rules.
