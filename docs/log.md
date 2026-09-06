# Documentation update log

## 2026-09-06
* **Update**: [Terminal design](/cli/terminal-design.md) and [Project and session state](/cli/project-state.md) — explicit startup refusal with one-key exit, and documented fresh initialization for installations that still have a prefixed tenant identity.
* **Creation**: [Terminal design](/cli/terminal-design.md) — compact Namzu identity, copper writing rail, quieter agent panels and one activity animation, with native scrollback and draft preservation.
* **Creation**: [Token budgets](/sdk/token-budgets.md) — one authority for parent and descendant tokens, atomic reservations, durable request receipts and conservative restart behavior; own usage remains separate from tree totals.
* **Update**: [Run limits](/cli/run-limits.md), [Run exit codes](/cli/run-exit-codes.md) and [Harness invariants](/sdk/harness-invariants.md) — aggregate delegation accounting, CLI scheduler wiring and checkpoint references to the canonical ledger.
* **Update**: [Ids](/sdk/ids.md) and [Project and session state](/cli/project-state.md) — UUID-only entity admission, one checkout-root binding without legacy directory overrides, and durable drain Topic resolution from its Session.
* **Update**: [The salience-scored working set](/sdk/salience-working-set.md) — one multimodal token estimate across context decisions, conservative rich-content scoring and safe result recovery; replaces the obsolete implementation plan.
* **Update**: [Run limits](/cli/run-limits.md) — explicit headless reasoning effort, hard stops without post-budget model calls, and one terminal streaming event after persistence.
* **Creation**: [Harness invariants](/sdk/harness-invariants.md) — child budget reservation and startup rollback, independent output budgets, artifact paths, and bounded live small-model observations.
* **Update**: [Ids](/sdk/ids.md) — kernel factories mint UUIDs; constructors and storage accept safe legacy IDs unchanged, and in-memory stores can hydrate existing Project and Topic snapshots.
* **Update**: [Project and session state](/cli/project-state.md) — delegated work retains the actual parent scope, child artifacts stay under the real Project, and tasks use the invoking run's default scope.
* **Update**: [Background jobs in the CLI](/cli/background-jobs.md) — corrected the index's obsolete claim that sandboxed sessions have no background jobs; regression coverage now checks both CLI exposure and sandbox-owned execution.
* **Creation**: [Project and session state](/cli/project-state.md) — new subdirectories share the checkout-root Project, existing directory bindings remain reachable, and identity and Topic initialization publish one winner across concurrent launches.
* **Update**: [Memory](/cli/memory.md) — new project notes use the checkout-root file; existing directory-local memory keeps precedence.
* **Update**: [Ids](/sdk/ids.md) — checked IDs require a nonempty portable suffix and session storage validates path components before using them.

## 2026-09-05
* **Update**: [Run limits](/cli/run-limits.md) — `--wait-for-provider <duration>` and `limits.waitForProviderMs`: a headless run waits out provider pauses and resumes from its checkpoint in the same process.
* **Creation**: [Tool servers](/cli/mcp-servers.md) — the `mcpServers` config key documented; `connectTimeoutMs` gives one server a longer connect deadline than the 10s default.
* **Creation**: [Exit codes of a headless run](/cli/run-exit-codes.md) — `namzu run` exits 75 (EX_TEMPFAIL) when the provider paused the run, so a wrapper can wait instead of retrying or giving up.
* **Creation**: [Pinned facts](/sdk/pinned-facts.md) — `ToolResult.workingState` and the MCP working-state resource; tools can now state facts into the working-memory slot.

## 2026-09-04
* **Creation**: [Memory](/cli/memory.md) — a project memory file beside the user one; `#note` and `/memory` write to the project by default; injected sections are capped.
* **Creation**: [Ids](/sdk/ids.md) — the `thd_` compatibility machinery is gone, retired prefixes are refused, a session can be created under a chosen id; the CLI mints its tenant and topic.
* **Creation**: [Run limits](/cli/run-limits.md) — `--max-iterations`, `--token-budget` and the `limits` config key; a headless run is no longer capped at a chat turn's 50 calls.

## 2026-09-02
* **Update**: [Background jobs in the CLI](/cli/background-jobs.md) — jobs run inside the sandbox now: the local provider starts them detached under the same confinement, the registry keeps them.
* **Creation**: [Adding a directory](/cli/add-dir.md) — `/add-dir`, `--add-dir`, `additionalDirectories`; the kernel's `query({ additionalDirectories })` reaches the tools and the sandbox.
* **Creation**: [File checkpoints](/cli/file-checkpoints.md) — every file recorded before a tool changes it, per turn; `/restore N` puts the tree back.
* **Creation**: [Slash commands](/cli/slash-commands.md) — every builtin and kernel command in one place; `/release-notes` is new.
* **Creation**: [Hook events](/sdk/hooks.md) — six more events (`user_prompt_submit`, `session_start`/`session_end`, `pre_compact`/`post_compact`, `subagent_stop`), the `annotate` result, and the shell hook contract for all ten; `/hooks` in the CLI.
* **Creation**: [The composer prefixes](/cli/composer-prefixes.md) — `!command` runs on the host without the model and the model reads the output next turn; `#note` remembers.
* **Update**: [Background jobs in the CLI](/cli/background-jobs.md) — a job is its process group: a command that backgrounds its work stays `running` until the survivor ends, and `kill` takes it.
* **Creation**: [Background jobs in the CLI](/cli/background-jobs.md) — session-owned jobs, exit notices for model and operator, `/jobs`.
* **Creation**: [Where the CLI stands against its peers](/cli/competitive-gaps.md) — the competitive survey and the backlog it orders.
* **Update**: consolidation landed — a run's learnings go to the memory store on request (`consolidateInto` in the kernel, `compaction.consolidate` in the CLI); the salience plan is complete.
* **Update**: compaction defaults to `salience` in the kernel and the CLI; `structured` stays selectable.
* **Update**: [The salience-scored working set](/sdk/salience-working-set.md) — the eval suite landed and two eviction rules with it; Phase 6's default flip and consolidation remain.
* **Creation**: [Context and compaction in the CLI](/cli/context-and-compaction.md) — the file-only `compaction` key and the `/context` command.
* **Update**: [The salience-scored working set](/sdk/salience-working-set.md) — phases 1–4 landed: scoring core, goal vector, working-set eviction, soft trigger; `strategy: 'salience'` is selectable.
* **Creation**: [The salience-scored working set](/sdk/salience-working-set.md) — the plan that makes per-message scoring and a dynamic context real; six phases, each with what it must prove.
* **Creation**: [The review policy](/sdk/review-policy.md) — the permission modes moved from the operator application into the kernel as `createReviewPolicy`.
* **Initialization**: `docs/` became an empty OKF v0.2 bundle. The pages written under the previous documentation standard were removed rather than migrated; a page returns when the code it describes is next touched, written to the bundle's rules.
