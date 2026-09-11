# Documentation update log

## 2026-09-11

- **Update** Added model-aware native search admission, Anthropic search replay, Google grounding, delegated native search and clean common-search previews.

- **Update** Common CLI web search uses stateless MCP requests, shared admission, bounded transient retries and cancellable waits.

- **Update** Passed configured independent web search into delegated tool registries, including read-only explore agents, and improved word wrapping in agent transcript pages.

- **Update** Applied the activity fill directly to the Working text, removing the additional activity wordmark.

- **Update** Moved Working animation into the Namzu wordmark and kept the composer frame static, with prompt and accessibility fallbacks.
- **Fix** Waited for asynchronous plan approval listeners before resolving the approval, preventing durable plan events from outliving run storage while preserving listener-failure isolation.

## 2026-09-10

- **Update** Added an interactive wordmark fill during CLI upgrades, with verified completion, bounded failure diagnostics and static output fallbacks.

- **Update** Shortened exit resume commands for matching PATH installations and omitted redundant working-directory changes.

- **Update** Scoped the Anthropic provider's optional Claude Code version probe out of framework filesystem tracing so server bundles do not absorb the consumer's complete project tree.

- **Update** Published deterministic valid entity-ID fixtures through the SDK's testing subpath for consumer test suites migrating from removed prefixed IDs.

- **Update** Documented exact host/guest rollout, guest-owned PTY and loopback TCP channels, explicit Firecracker network-policy admission, and plan-step identity on pending delegated work.

- **Update** Removed bundled OAuth application credentials from the Google integration; expired borrowed sessions require owner renewal or explicit matching application configuration.

- **Update** Recorded live CLI creation, external-edit preservation after resume, and approved parallel-agent checks; prepared an example-only terminal capture for the READMEs.

- **Update** Added local installation identity to CLI status: package version, executable path and content fingerprint.

- **Update** Reread and renew Anthropic credentials before delegated client construction and model discovery, including concurrent child launches.

- **Update** Replaced the bracketed CLI wordmark with compact two-row terminal lettering and a narrow/short-screen fallback.

- **Update** Replaced Ctrl+O transcript reprints with a bounded output viewer for older or oversized results; added xterm screen checks for pagination and repeated opening.

- **Update** Enforced file fingerprint checks before matching-anchor and sandbox edits; added host-owned SDK observation tracking and CLI tracking across live conversation turns.

- **Update** Added SDK request-only exact observation deduplication, CLI opt-out, research rationale and tests for surviving evidence and external file changes.

- **Update** Added SDK request-context inventories and occurrence-aware differences at the model-call hook, separating surviving call inputs from removed result content.

- **Update** Distinguished request-visible content from retained history and corrected rich-content omission recovery so it does not direct agents to replay state-changing tools.

- **Update** Refined coding-agent evidence reuse and proportional verification; corrected CLI prior-turn evidence and kernel/SDK identity while retaining tool permissions.

- **Update** Added observed file-write receipts and completed-write diff summaries; made approval previews explicit about possible replacement and corrected final-newline counting.

- **Update** Rendered `/status` as a structured Ink card with responsive columns and matching transcript height accounting.

- **Update** Enabled automatic native/common CLI web search routing by default; added guided optional CLI setup; retained explicit native search and added the `/config` entry and compact session status card.

## 2026-09-09

- **Creation** Added opt-in [hosted web search](cli/web-search.md) through the Codex subscription driver, with source retention, observable activity, and unsupported-route refusal.

- **Update** Fixed placeholder titles and added selected-chat previews and explicit saved-goal continuation to the [resume picker](cli/slash-commands.md).

- **Update** Added session-scoped [delegation receipts](cli/delegated-work.md) to resumed model context, with archived result lookup and explicit unresolved execution status.

- **Update** Scoped [unresolved token receipts](sdk/token-budgets.md) to their owning account and shared finite allowances, preserving unlimited sibling progress and exposing uncertainty in CLI usage.

- **Update** Added owned-task cancellation to [delegated work](cli/delegated-work.md), with mixed-outcome regression coverage and the unresolved-provider-receipt limitation.

- **Update** Suppressed duplicate project-instruction notices during [model changes](cli/terminal-design.md) while retaining notices for changed file lists.

- **Update** Added a compact [model catalogue view](cli/terminal-design.md) with exact JSON retained behind Ctrl+O.

- **Update** Added explicit [child model selection](cli/delegated-work.md), model discovery, and [unlimited CLI token budgets](cli/run-limits.md) backed by durable [child accounts](sdk/token-budgets.md).

- **Update** Grouped successful observations in [terminal activity](cli/terminal-design.md) using optional [tool presentation metadata](sdk/tool-execution.md), retaining expandable output and explicit failures.

- **Update** Preserved originating run identity in [review prompts](sdk/review-policy.md) and displayed the requesting agent on [queued CLI approvals](cli/delegated-work.md).

- **Update** Documented the explicit [Gemini CLI home override](cli/google.md) and account-isolated credential discovery.

- **Creation** Added [Google account integration](cli/google.md), native SDK model transport and read-only reuse of Gemini CLI sign-ins.

- **Update** Separated [named agent completion rows](cli/delegated-work.md) from wait calls, preserving error visibility and agent transcript access.

- **Update** Documented [concurrent approval handling](cli/delegated-work.md), per-request decisions and cancellation of queued reviews.

- **Update** Separated [agent execution status from planning tasks](cli/delegated-work.md), labelled incomplete stops in results and notifications, and expanded the agent browser viewport.

- **Update** Documented [bracketed paste and response boundaries](cli/terminal-design.md), character-count chips and named [delegation receipts](cli/delegated-work.md).

- **Update** Made [agent permission reviews](cli/delegated-work.md) compact, grouping task rows by supplied workflow labels while retaining exact input behind `d`.

- **Update** Clarified the subscription driver name in [native provider capabilities](sdk/native-provider-capabilities.md); scoped source-attribution and provider-fixture name-audit exceptions to their reviewed files.

- **Update** Added opt-in [identifier-grounded memory recall](sdk/memory.md) and recorded a [24-run candidate comparison](sdk/memory-recall-scores.md); retained the default after higher measured token use without factual improvement.

- **Update** Recorded [24 live memory-recall comparisons](sdk/memory-recall-scores.md), separating factual correctness, answer-format compliance and measured token/tool consumption.

- **Update** Bounded overlapping optional [memory recall](sdk/memory.md) reads and recorded [retrieval research decisions](sdk/memory-research.md), separating returned-result limits from scan cost.

- **Update** Added [current-run task context](cli/task-context.md), projecting unfinished work with scope checks and bounded waiting; documented upstream research and deferred retrieval improvements.

- **Update** Added [exact retained-text reading and visible context inventory](cli/conversation-evidence.md), with scoped durable addresses, bounded pages and pressure-aware request metadata.

## 2026-09-08

- **Update** Added [paired harness verification](sdk/harness-verification.md), based on HarnessLens, and [paged conversation evidence](cli/conversation-evidence.md) for large transcripts.

- **Update** Native output mappings now cover Codex, OpenRouter, DeepSeek, HTTP dialects and Zen; TUI accepts `--output-schema` with lossless schema admission. Anthropic transport retries default to zero so throttles reach the host immediately.


* **Update** Added [native structured output](sdk/native-structured-output.md) and [provider admission](sdk/native-provider-capabilities.md), with checkpointed corrections, steering/cancellation checks and guardrail invalidation.

* **Update** Fixed [Anthropic native JSON transport](sdk/structured-output-review.md) to forward schemas alongside reasoning effort and reject unsupported format semantics before dispatch.

* **Update** Added host-authorized [AG-UI initial message snapshots](sdk/ag-ui.md), with bounded publication before native streaming and official HttpAgent verification.

* **Update** Added [structured output review](sdk/structured-output-review.md) and [tool call budgets](sdk/tool-call-budget.md), covering host acceptance and durable execution admission.

* **Update** Corrected [tool discovery](sdk/tool-discovery.md) to distinguish verified active matches from unknown tools and respect an empty allowed-tool list.

* **Update** Added [exact computer action capabilities](sdk/computer-actions.md); unsupported macOS gestures are excluded and refused before execution.

* **Update** Recorded a source-pinned [framework and computer-use gap audit](sdk/framework-gap-audit.md), desktop readiness probe, capability-advertising defect and AG-UI interoperability limits.

* **Update** Added [model-owned reasoning metadata](sdk/model-reasoning.md) and provider-neutral discovery for session effort controls.
* **Update** Interactive [model selection](cli/slash-commands.md) now continues to the selected model's effort menu; queued work waits for selection, and Escape keeps the selected model at its default effort.
* **Update**: [Tool execution barriers](/sdk/tool-execution.md), [Conversation evidence](/cli/conversation-evidence.md) and [Delegated work](/cli/delegated-work.md) — explicit SDK ordering, CLI write/verify boundaries, run-scoped retained evidence search, background delegation and queued child corrections.
* **Update**: [Slash commands](/cli/slash-commands.md) and [OpenAI reasoning menus](/sdk/openai-reasoning.md) — searchable models, direct host selection for standalone model requests, composer selection previews and exact Astra effort menus.
* **Update**: [Conversational model changes](/cli/slash-commands.md) and [Terminal design](/cli/terminal-design.md) — successful solitary switches settle without acknowledgement inference, repeated requests reuse acceptance, missing IDs receive bounded relevant choices, and empty deferred-tool search is withheld. [Harness efficiency review](/cli/harness-efficiency-review.md) records pinned upstream comparisons and measurable remaining gaps.
* **Update**: [Slash commands](/cli/slash-commands.md) and [Terminal design](/cli/terminal-design.md) — conversational model requests queue a session-only change after the active turn settles, resolve exact usable models, preserve history and identity, and confirm only successful application.
* **Update**: [Zen and Zen Go](/sdk/zen.md) — anonymous access defaults to public Muse Spark 1.3 Contributor Free, public discovery requires no installed client, and CLI credential lookup reuses separate OpenCode API-key entries without modifying their file; explicit public selection suppresses stored accounts, Responses tools preserve optional fields, and live public text inference is distinguished from catalogue and fixture coverage.

## 2026-09-07
* **Creation**: [Zen and Zen Go](/sdk/zen.md) — optional providers and CLI selection with exact native protocol routing, stable conversation attribution, validated reasoning replay, live catalogue admission and explicit transport and billing limits.
* **Creation**: [AG-UI clients](/sdk/ag-ui.md) — optional typed/SSE adapter with explicit host identity and history admission, backend tools, request-owned state, bounded events, final outcomes and documented CopilotKit compatibility limits.
* **Update**: [Harness invariants](/sdk/harness-invariants.md), [Token budgets](/sdk/token-budgets.md) and [Project state](/cli/project-state.md) — live delegation width releases completed history; bounded queued admissions preserve task ownership and reserve a parent coordination share.
* **Update**: [Terminal design](/cli/terminal-design.md) — independent workflows no longer become phases of earlier work; queued children, agent launch permissions and abnormal run stops have explicit displays.
* **Update**: [Terminal design](/cli/terminal-design.md) — the opening header keeps only brand/version; model and working directory appear in the footer, routine connection chatter is suppressed, and the composer owns the typing hint; contracted terminals rebuild the retained transcript, and subagent panes bound file-output wrapping and separate phase/task/status columns.
* **Update**: [Run exit codes](/cli/run-exit-codes.md) and [Run limits](/cli/run-limits.md) — buffered output uses the kernel's settled answer instead of concatenated narration and rejected candidates; streaming hosts receive that result as `done.text`.
* **Creation**: [Answer verification](/sdk/verification.md) — command/fingerprint errors and interrupted zero-exit checks cannot pass verification, cancellation reaches commands, and diagnostic clipping respects its character allowance; remaining completion-path limits are explicit.
* **Update**: [The salience-scored working set](/sdk/salience-working-set.md) — non-shrinking summary candidates are declined, useful staged clears survive, original clear/stub evidence is archived before replacement, and changed working-memory slots invalidate stale provider measurements.
* **Update**: [The salience-scored working set](/sdk/salience-working-set.md) — model changes resolve their own provider window, recheck compaction and use that denominator for telemetry and recovery; preparation order and remaining fit limits are explicit.
* **Update**: [Structured memory](/sdk/memory.md) — newly queued resume input takes precedence over old checkpoint intent, and operator steering updates the bounded state used by compaction.
* **Creation**: [Bounded code execution](/sdk/code-execution.md) — QuickJS interpreter isolation, explicit source/value/memory/call limits and optional structured nested-tool results with unchanged authorization.
* **Creation**: [Cognitive storage research](/sdk/cognitive-storage.md) — pinned Pydantic AI source comparison, proposed RAM/disk/index responsibilities, transactional update boundaries and a bounded local storage-cost experiment.
* **Creation**: [Cognitive architecture research](/sdk/cognitive-architecture.md) — primary-source motivation, functional definitions, proposed selective control cycle, scoped associative activation, outcome/evidence distinctions, local CPU measurements and executable SDK mechanism ablations; explicitly separate from shipped CLI behavior.
* **Update**: [Harness invariants](/sdk/harness-invariants.md) — advisory triggers use current context occupancy and the latest canonical tool failures rather than cumulative spend and stale error text.
* **Creation**: [Structured memory](/sdk/memory.md) — bounded per-step recall, current operator intent retained across compaction and checkpoints, ranked body search, explicit correction/archive/delete tools, and cooperating-process disk coordination with honest recovery limits.
* **Update**: [Memory](/cli/memory.md) and [Context and compaction](/cli/context-and-compaction.md) — default project recall with a file-config opt-out, one selected durable-memory writer, bounded scoped markdown reads and visible skipped-file or clipped-note diagnostics.
* **Update**: [Pinned facts](/sdk/pinned-facts.md) — removing the last tool pin clears its managed context slot; extracted negative requirements survive, assistant decisions retain source attribution, and bounded requirements disclose truncation.
* **Update**: [Ids](/sdk/ids.md) — `query` and `drainQuery` reject missing session, topic, project or tenant identity before provider calls, run events or persistence, including untyped JavaScript callers.
* **Update**: [The salience-scored working set](/sdk/salience-working-set.md) — verification retains rich-result text, tool-call chronology and attachment descriptors within one character budget, without copying encoded attachments or provider-private reasoning.
* **Update**: [Harness invariants](/sdk/harness-invariants.md) — full delegated results remain readable from their parent ledger after manager eviction, with foreign-parent and closed-runtime access refused.
* **Update**: [Terminal design](/cli/terminal-design.md) — long conversation names and goals use a cursor-following single-line editor, preserving the complete value through narrow terminals and resizing.
* **Creation**: [Run the kernel](/sdk/quick-start.md) — runnable offline SDK examples, explicit history and identity ownership, and agent-kernel positioning across the repository entry points.

## 2026-09-06
* **Update**: [Bounded file discovery](/sdk/file-discovery.md) — content search now enumerates incrementally with cancellation, a 15-second deadline, explicit traversal/result limits and retained partial matches, replacing eager sandbox directory listing.
* **Update**: [Harness invariants](/sdk/harness-invariants.md), [Terminal design](/cli/terminal-design.md) and [Slash commands](/cli/slash-commands.md) — operator input releases delegation waits without cancelling children, completion delivery wakes for new messages, cancelled turns retain tool evidence, and child transcripts use a distinct framed screen with retained completed work and clear return navigation.
* **Update**: [Slash commands](/cli/slash-commands.md) and [Command experience audit](/cli/command-experience-audit.md) — command-specific `/help` reports usage and availability without invoking the target, and identifies user-command source paths, scope and refusal problems.
* **Update**: [Slash commands](/cli/slash-commands.md), [Memory](/cli/memory.md), [Terminal design](/cli/terminal-design.md) and [Command experience audit](/cli/command-experience-audit.md) — plain permission choices with advanced options, effective approval state in settings, explicit all-tool approval scope, and read-only memory inspection commands with explicit note creation.
* **Creation**: [Bounded file discovery](/sdk/file-discovery.md) — explicit shallow and recursive glob scope, incremental local and remote sandbox enumeration, cancellation, traversal limits, path handoff fixes and adapter upgrade requirements.
* **Update**: [Harness invariants](/sdk/harness-invariants.md) and [Terminal design](/cli/terminal-design.md) — bounded file discovery, known-path reads without mandatory discovery, and visible glob patterns alongside search directories.
* **Update**: [Harness invariants](/sdk/harness-invariants.md) and [Peer comparison](/cli/competitive-gaps.md) — foreground host-shell process-group cancellation, preserved partial output and bounded pipe cleanup, with Linux subprocess regressions and explicit containment limits.
* **Update**: [Terminal design](/cli/terminal-design.md), [Slash commands](/cli/slash-commands.md) and [Peer comparison](/cli/competitive-gaps.md) — bounded beginning/end tool previews with recoverable omitted lines, and visible provider alternatives in the current model menu.
* **Update**: [Terminal design](/cli/terminal-design.md), [Harness invariants](/sdk/harness-invariants.md) and [Peer comparison](/cli/competitive-gaps.md) — recoverable tool previews, incremental host-shell progress, preserved timeout and cancellation evidence, bounded provider cancellation with conservative token accounting, and pinned primary-source comparisons with terminal animation regressions.
* **Update**: [Slash commands](/cli/slash-commands.md) — resume hints retain the actual launcher and working directory so a checkout session is not handed to an older global CLI.
* **Update**: [Slash commands](/cli/slash-commands.md), [Context and compaction](/cli/context-and-compaction.md), [Terminal design](/cli/terminal-design.md) and [Command experience audit](/cli/command-experience-audit.md) — shared discovery and searchable choices, scoped settings and goals, preserved model preferences, accurate permission and usage summaries, actual run task lists, and explicitly historical audit findings with remaining limits.
* **Creation**: [Command experience audit](/cli/command-experience-audit.md) — verified preference, permission, task, discovery and usage-report defects, with a comparison against pinned Codex source and a proposed implementation order.
* **Update**: [Terminal design](/cli/terminal-design.md) — a short green light follows the working composer's border, with shared animation scheduling, stable input geometry, and quiet idle, overlay and accessible output states.
* **Update**: [Terminal design](/cli/terminal-design.md) — phosphor-green wordmark and square message frame, exact indexed colors, no empty frame beneath text prompts, and a stable scrollback owner through provider selection.
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
