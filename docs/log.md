# Documentation update log

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
