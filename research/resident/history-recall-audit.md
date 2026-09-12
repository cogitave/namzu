# Resident recall milestone audit — 2026-09-12

The active goal is bounded, scope-safe recovery of prior resident decisions and
retained evidence beyond the latest summary, integrated with actual resident
execution and verified across restart, compaction, conflicting inputs and
interruption. It also requires primary-source inspection, a small low-effort
CLI exercise, reproducible evidence, documentation, changesets, appropriate
checks and local commits. The wider autonomous-kernel vision remains unfinished.

The implementation was committed in `f4b3ffb2`. This audit re-read the actual
source and test coverage, verified live result files and runtime fingerprints,
then added two stronger query-compaction tests and a Luna/low CLI run. Earlier
successful reports alone were not treated as sufficient evidence for completion.

| Requirement | Authoritative evidence inspected | Result |
| --- | --- | --- |
| Inspect existing persistence and retrieval | CLI `integrations/resident/session-step.ts` creates an isolated Session per admission; `integrations/sessions/conversation-search.ts` binds conversation search to one Session. SDK agenda revisions retain earlier summaries and consumed wake inputs. | The reachability gap is identified; the new source reads the retained substrate. |
| Inspect a relevant primary implementation | Clean local Pydantic AI Harness source at `c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504`, `_source.py` and `_capability.py`; links and bounded conclusions in [the research record](history-recall.md). | Source/retrieval separation, positional history identity and explicit scope informed the design. |
| Implement SDK recovery beyond the summary | `manager/resident/history.ts`, `history-disk.ts`, `DiskResidentAgenda.history`, `tools/resident-history.ts`, and exported types/tools. `history.test.ts` reads exact previous summaries and consumed inputs absent from latest state. | Implemented and verified without replaying effects or adding a second mutable history store. |
| Bound work and results | `history.test.ts` covers 75 control revisions, empty pages, page resumption, 3 MB records, unavailable records and Unicode paging. Reader checks each file before allocation; source caps attempts, actual bytes and returned text separately. | Search stays within 32 revision attempts and 8 MiB per page; reads are capped at 6,000 code units; continuation progresses. |
| Enforce scope | SDK history tests exclude a different pursuit and tenant and refuse future revisions. Tool tests reject model-selected scope/path fields before host resolution. CLI `resident-history-reaches-session.test.ts` refuses unrelated and departed Run IDs. | Host-owned tenant/resident/pursuit/upper-revision boundary reaches actual tool execution. |
| Integrate resident execution | Foreground `commands/resident.ts` and managed `runner-worker.ts` pass their bound agenda to `createResidentSessionStep`. Profile tests inspect the admitted source boundary; real CLI runs dispatch both tools under plan permissions and deferred loading. | Both composition paths are wired; foreground execution is live-verified. No managed-worker live claim is made. |
| Restart | Reproducer add/seed/status/wake/run commands open separate processes. SDK readers are reopened independently. After live completion, another CLI run admits no extra step. | Retained evidence is reachable after reopening without replay or an in-memory-only index. |
| Compaction | `runtime/query/__tests__/resident-recall-after-compaction.test.ts` runs both structured and sliding-window strategies. A compaction completion event precedes history tools; the old identifier is absent from the first provider request and present in the exact tool result and later provider request. | Exact recall works through the real query after context removal. Deterministic provider coverage is distinct from natural model compaction. |
| Stale/conflicting evidence | Both Zen profiles and Luna read the original tracking input and a later address correction. Random identifiers prevent guessing; live tool events and summaries match the corrected input. SDK guidance and provenance distinguish recorded claims from current external verification. | Later corrections are accessible and used in these scenarios. This does not independently verify arbitrary external state. |
| Interruption | `agenda.proc-test.ts` kills a worker after a file effect, reopens unresolved ownership and observes no completed history entry. Explicit inspected settlement then makes the consumed input readable; the older bound source still cannot see it. | No incomplete result is invented and no effect is replayed to retrieve evidence. |
| Small-model CLI run | [Luna/low result](results/2026-09-12-history-recall-luna.json): one admission, one search, two reads, 14,246 reported tokens, valid terminal decision and confirmed cleanup. | Passed with the built CLI. No costly larger-model run was added. |
| Reproducible evidence | `history-recall-cli.mjs` supports local-only mode, Zen live profiles and `--live --codex`. Synthetic expected values, actual tool inputs/completions, usage, local fixture paths and source/build fingerprints are recorded. | Three live admissions are documented without claiming general benchmark superiority or measured monetary savings. |
| Documentation and changesets | `docs/sdk/resident-recall.md`, resident context/retention/CLI pages, indexes, log and `.changeset/resident-evidence-recall.md`; an additional regression changeset covers the audit test. | Public API, limitations and verification scope are documented. |
| Checks | Workspace typecheck, build, lint, package tests, docs/fences, signature exports, SDK test presence and references passed on the implementation. Audit adds two passing query tests, all 252 SDK process tests, and rechecks typecheck/lint/docs. | Appropriate development checks passed; a complete release-gate run is not claimed. |
| Local commit and no publication | Implementation commit and audit commit use the required repository author. Working tree is checked after commit; no push or registry publication command was run. | Delivered locally, awaiting separate release authorization. |

The milestone recovers the evidence this substrate already retains: settled
summaries and accepted wake inputs. It does not claim complete historical tool
transcript retrieval, indexed semantic search, autonomous external-state
verification or a fully realized cognitive architecture. Those remain distinct
future development, not unverified claims attached to this milestone.
