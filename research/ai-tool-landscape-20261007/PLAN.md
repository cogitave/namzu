# Namzu Desktop adoption plan (2026-10-07)

Inputs: SYNTHESIS.md (15 repos, npm metadata, no installs) and three trial reports (transcript, ui-infra, code-terminal-watch). Where a trial contradicts the synthesis, the trial wins; the contradictions are listed first.

## 0. Corrections to the synthesis (trial evidence)

| Synthesis said | Trial found | Plan follows |
|---|---|---|
| ADOPT remend to heal the streaming tail | remend 1.4.0 mis-nests `**bold and \`cod`, appends a stray `_` to `a_b` (corrupts identifiers), emits `streamdown:incomplete-*` placeholder URLs | Do NOT adopt as-is. Own block-level memoisation first; remend only after a fuzz-tested wrapper |
| streamdown 2.7 trial on the live message | 3x slower than react-markdown in Node SSR, raw HTML rendered by default, needs rebuilding of copy/link-preview/file-ref/document mode, second shiki copy | Do not trial. Keep react-markdown |
| sonner if Base UI has no toast | Base UI 1.4.1 DOES ship `@base-ui/react/toast` | Base UI Toast, zero new packages. sonner is fallback only |
| chokidar vs fs.watch trial | @parcel/watcher 2.6.0 works but is native + optionalDependencies | See wave 5: dependency-free first |
| Namzu file-watch unknown | confirmed: none; refresh is a manual `filesRefresh` bump in app.tsx | Wave 5 |

## 1. Delivery constraint that shapes every wave

Desktop is delivered to the Windows install by `research/desktop-delivery-20261007/native-update.cjs` as whole `dist` swaps. The installed app has only `node_modules/ws` plus whatever the updater adds. The 2026-10-07 `ERR_MODULE_NOT_FOUND` failure (project-files.js importing `yaml` and `ignore`) is the precedent. The updater's module path:
- adds a main-process bare import only if the package has NO `dependencies`/`optionalDependencies`, and refuses on a version mismatch;
- anything with dependencies or native prebuilds (@parcel/watcher, @vscode/ripgrep, @lydell/node-pty, chokidar 5 via readdirp) needs a deliberate junction rebuild and updater support, not a silent add.

Rules: (a) main-process packages must be dependency-free, or the wave names the shipping change; (b) renderer packages are bundled by Vite into `dist/renderer`, so they ship with the dist swap with no updater change (still add a `licenses/*` entry and list it in `scripts/retain-notices.mjs` + THIRD-PARTY-NOTICES.txt); (c) renderer CSP is `connect-src 'none'`: no package may fetch (rules out CDN-loading highlighters/mermaid grammars at runtime, workers must be same-origin or `blob:` per the dev CSP); (d) never rebuild dist during a run.

## 2. Waves (ordered)

### Wave 1: @pierre/diffs 1.3.0-beta.10 -> 1.5.2 and diff size gate (renderer)
- Package: `@pierre/diffs@1.5.2` (Apache-2.0, 2026-10-05). Renderer, bundled.
- Files: `packages/desktop/package.json`, pnpm-lock, `renderer/diff-theme.ts`, `renderer/changes-review/*` (diff view), `renderer/file-panel/file-panel.tsx` (read-only view), `licenses/` + notices.
- Add: rich-diff size gate (fall back to plain patch above ~180k chars or ~1200 lines; ZCode `GitPane/helpers.ts`), optional worker pool (`@pierre/diffs/worker`, same-origin worker only, CSP `worker-src`).
- Deleted: the beta pin; any local workaround for beta bugs found while upgrading (inspect first).
- Proof: existing changes-review and file-tab tests pass; a pure test for the gate thresholds; real-Electron look at a 5k-line diff in `preview.html`; Windows: nothing native.
- Risks: beta->stable API drift (read the 1.3->1.5 changelog; I did not); worker CSP.

### Wave 2: toasts via Base UI Toast (renderer, no new package)
- Files: `renderer/app.tsx` (remove `notice` string state, `noticeTimer`, `<output class="conversation-action-toast">`), new `renderer/toast.tsx` (Provider/Portal/Viewport + `notify(text,{action})` over `createToastManager()` so IPC handlers can call it), `renderer/*.css` (viewport above composer via `--composer-height`), `turn-changes-card`/undo callers.
- Deleted: single-string notice + timer, its CSS.
- Proof: unit test for the notify helper (queue, action, dismissal with fake timers); `aria-live` kept; PTY/real-window check that two overlapping notices both show.
- Risks: stacking visuals need CSS; Base UI 1.4.1 vs 1.8.0 (upgrade separately, changelog unread). Fallback: sonner 2.0.8 (`unstyled`).
- Win: undo/retry action buttons (turn-undo in the CLI checkpoints work needs one).

### Wave 3: transcript streaming cost and scroll polish (renderer, no package)
- Files: `renderer/transcript.tsx`, `message.tsx` (MarkdownBody), `use-transcript-scroll.ts`, `transcript-motion.*`, new `renderer/markdown-blocks.ts` (+ test).
- Do: split streaming text at blank lines outside fences, memoise each settled block with existing `MarkdownBody` (skipHtml and component map unchanged), only the tail re-parses; 50 ms throttle on the live text (Goose `useThrottledStreamingText`); stable component map and memoised plugin arrays (T3 ChatMarkdown.tsx). Scroll: pause follow when a disclosure opens (assistant-ui), ignore programmatic scroll events (OpenCode markAuto), per-conversation remembered position with at-end flag (T3, Cherry). CSS `content-visibility:auto` + `contain-intrinsic-block-size` on settled turns (monocode).
- Deleted: nothing; whole-body re-render on every delta goes away.
- Proof: pure tests for the block splitter (fences, tables, lists, unterminated fence, CRLF); a fuzz test asserting concat(blocks)==input and render(blocks)==render(whole) for settled text; real-Electron measurement before/after on a long transcript (profile, not Node SSR). Virtualisation stays OFF unless this measurement shows a long-thread problem; then `virtua@0.53.3` trial in a real Electron run (not `@tanstack/react-virtual` for the transcript).
- Risks: markdown constructs that span blank lines (reference links, loose lists, html blocks) split wrongly: the fuzz test must cover them; content-visibility breaks in-page find/scroll anchors, so check with transcript search (research/transcript-search-timing-20261007).

### Wave 4: changes and undo UX (renderer + CLI checkpoints already in tree)
- Files: `renderer/turn-changes.ts`, `turn-changes-card.tsx`, `changes-review/*`, plus the in-flight `packages/cli/src/checkpoints/*` (undo-plan.ts, manifest.ts).
- Do: per-turn summary per path (first before -> final after, skip pending/failed calls; ZCode `taskChangeSummary.ts`, LobeHub `deriveEditedFiles.ts`); rewind preview classifying safe/unsafe/ignored before applying (ZCode `ConversationFileRewindDialog.tsx`), "current state saved as a checkpoint before restore" (Opcode: idea only, AGPL); stable-reference refresh so only changed files re-render (monocode `stableDiff.ts`); inline diff comments formatted as a prompt (monocode `diffComment.ts`) using @pierre/diffs annotations.
- Packages: none. Optional trial `@pierre/trees@1.0.0-beta.6` for the changes tree only, behind a flag; keep @headless-tree for files.
- Proof: pure tests for aggregation and classification; real undo on a scratch repo (CLI work already has undo-plan tests).
- Risks: Windows path case/CRLF in classification; uncommitted CLI checkpoint work must land first (dependency on that change set).

### Wave 5: file freshness and content search (MAIN process, delivery-sensitive)
- 5a (dependency-free, ship first): replace the manual `filesRefresh` bump with a debounced (150 ms, `refreshAgain` flag; monocode) refresh on agent write + window focus, and `fs.watch(dir)` only for EXPANDED directories (ZCode generation-counter pattern). Files: `main/project-files.ts` (+ IPC `files:changed` in preload/index), `renderer/file-panel/*`, `app.tsx`. No package; Node built-in. WSL/`/mnt` keeps focus-refresh only (fs.watch is unreliable there).
- 5b (deliberate, only if 5a is insufficient on real trees): `@parcel/watcher@2.6.0`. Needs updater change (optionalDependencies today = refused), Electron 44 load test of the win32-x64 `watcher.node` (531 KB), asar-unpack. Chokidar 5 is the pure-JS fallback but pulls readdirp (also a dependency, also refused by the simple path).
- 5c content search: `@vscode/ripgrep@1.18.0`, main-process spawn of the absolute `rgPath` from `app.asar.unpacked`, paths through `confineProjectPath`, `--json`. Shipping: rg.exe is 5.4 MB from per-platform optionalDependencies, so the updater needs a new "binary module" class; do this as its own reviewed change. Filename search stays fuzzysort + the existing walker.
- Deleted: manual refresh token plumbing (5a).
- Proof: fake-timer tests for the debounce/refreshAgain model; a real-FS test (tmp dir) for the watcher; on Windows install, `--probe-only` plus an explicit module check; the `snapshot-modules.mjs` scan must list exactly the intended new modules.
- Risks: this is the wave that repeats the ERR_MODULE_NOT_FOUND failure if the updater is not extended first. Extend and test the updater BEFORE merging any 5b/5c import.

### Wave 6: tool output and fences (renderer)
- Packages: `ansi-to-react@6.2.6` (BSD-3, renderer; check licence text in notices; alternative `anser` without React wrapper); no new highlighter: use the shiki already inside @pierre/diffs for fences (singleton highlighter + LRU keyed code+lang+theme, not while streaming; T3, Jan StreamingCode).
- Files: `renderer/tool-view.tsx`, `message.tsx` code block path, `markdown-code-copy.ts`.
- Proof: tests for ANSI sanitising (no raw HTML injection through the colour wrapper), LRU eviction; bundle-size diff of the renderer chunk measured (not done in this survey).
- Risks: two shiki instances (trial said `@streamdown/code` would add one; the @pierre route avoids it, but confirm @pierre exposes a usable highlighter API at 1.5.2).

### Wave 7: tasks, background work, sessions UI (renderer, patterns only)
- Files: `conversation-tasks.tsx`, `job-row.tsx`, `sidebar-background-work`, `conversation-tabs*`, `renderer/transcript.tsx` (sub-agent rows).
- Do: composer-attached progress tray (collapsed shows only in-progress item, completed/total counter, active item centred; Roo, LobeHub TodoProgress, T3 ComposerTasksBadge; render null until data exists, Jan CoworkTodoChip); background dock with pure presentation helper (LobeHub `TaskDock/presentation.ts`; auto-dismiss only on success); sub-agent run rows with phase/duration/tokens and replay of finished runs through the same message component (Jan CoworkTasksPanel); status normaliser (monocode `taskList.ts`).
- Optional trial: `@formkit/auto-animate` (~2 KB, unmeasured) for task-list/sidebar add-remove, honouring prefers-reduced-motion.
- Packages otherwise none. Proof: pure tests per helper; real-window check of the tray.
- Risks: LobeHub source is licence-restricted: copy the idea, write the code fresh.

### Wave 8: in-transcript find, folders polish (renderer)
- In-transcript find: own text index + CSS Custom Highlight API (no DOM mutation; ZCode/monocode patterns). Must coexist with content-visibility from wave 3 (force-render the match's turn). Reconcile with existing `research/transcript-search-timing-20261007`.
- Folders: sticky ancestor folders, git-status styling, collapsed single-child chains, instant remount from cached `listDir` (OpenCode `file-tree-v2-model.ts`, ZCode `workspace-file-tree/*`, monocode `fileTree.ts`); drag a tree file onto the composer as a mention (T3 `fileTreeDragMention.ts`).
- Packages: none (keep @headless-tree 1.7.0 and react-virtual for trees).
- Proof: model tests; real-Electron find over a 500-turn transcript.

### Deferred, with trigger
- Terminal: output-only ANSI (wave 6) first. Interactive PTY = xterm 6 (+fit, serialize, search) renderer + `@lydell/node-pty` main; blocked on a permission design (a PTY shell bypasses command permissions) and native shipping. Not scheduled.
- File editor: CodeMirror 6 lazy-loaded on first edit; no Monaco (107 MB). Not scheduled.
- Virtualised transcript: only on measured need (wave 3).
- react-resizable-panels 4.14.2 (19 KB gz): only when a second split pane appears; until then keep the 60-line handle and copy Jan's rules (clamp, pointer-events off while dragging, double-click reset).
- `@tanstack/hotkeys`: at 1.0, keep the keyCode 229 guard. `motion`: only for exit/layout animation (29.5 KB gz with LazyMotion).
- Mermaid: lazy, after a stream settles (T3), renderer only; needs CSP/worker check.
- Command palette: keep Base UI; optionally rank with fuzzysort via the `filter` prop. cmdk rejected (stale, pulls Radix).
- Tiptap composer chips: only if inline mentions are wanted; heavy.

## 3. UI/UX patterns to copy, by area (source app : path under its repo in landscape/repos/)

Licence column: C = code may be read and re-written (MIT/Apache; keep attribution when copying); I = idea only (AGPL/LobeHub).

### Transcript
| Pattern | Source | Path | Lic |
|---|---|---|---|
| Release streamed text only to blank line / closed fence | T3 Code | apps/server/src/orchestration-v2/assistantStreaming.ts | C |
| Stable component map, memoised plugins | T3 Code | apps/web/src/components/ChatMarkdown.tsx | C |
| Block split, only tail is live | OpenCode | packages/session-ui/src/components/markdown-stream.ts | C |
| 50 ms throttled streaming text | Goose | ui/ (useThrottledStreamingText; path unconfirmed) | C |
| Follow state machine, hydration window | Roo Code | webview-ui/src/hooks/useScrollLifecycle.ts | C |
| Viewport follow, 2 modes | Cherry Studio | components/chat/messages/list/useViewportFollowState.ts | I |
| Pause follow on disclosure | assistant-ui | packages/react/src/primitives/thread/useThreadViewportAutoScroll.ts | C |
| Pin sent message to top, shrinking spacer | LobeHub / T3 | src/features/Conversation/ChatList/hooks/useConversationScroll.ts / ChatView.tsx anchoredEndSpace | I / C |
| content-visibility on off-screen turns | monocode | src/features/monos/hooks/useMonoTranscript.ts (+css) | C |
| Transcript export as pure function | OpenCode | packages/tui/src/util/transcript.ts | C |

### Tool calls
| Pattern | Source | Path | Lic |
|---|---|---|---|
| Tool presentation as pure modules | T3 Code | packages/client-runtime/src/work-log/* | C |
| Tool-call approval UI | Cline | apps/vscode/webview-ui/src/components/chat | C |
| Sanitised ANSI output | ZCode / Cline hub | ansi-to-react use sites (paths unconfirmed) | C |
| Convergent reducer with seq/epoch | Cline | messageReducer.ts (exact path unconfirmed) | C |

### Reasoning
| Pattern | Source | Path | Lic |
|---|---|---|---|
| Model trajectory timeline, search, expansion | ZCode | packages/ui/src/ModelTrajectory*.tsx | C |
| Workflow timeline | ZCode | packages/ui/src/components/workflow-timeline | C |
| Thinking panel as inner scroll box (use-stick-to-bottom throwaway trial) | ZCode | packages/ui (simple variant) | C |
| Reasoning/plan components | Vercel AI Elements | reasoning, plan (component listing NOT done) | C |

### Tasks / todos
| Pattern | Source | Path | Lic |
|---|---|---|---|
| Composer progress tray | Roo / T3 / LobeHub | TodoListDisplay.tsx / ComposerTasksBadge.tsx / src/features/Conversation/TodoProgress/index.tsx | C / C / I |
| Status normaliser | monocode | src/features/sessions/model/taskList.ts | C |
| Chip null until data | Jan | web-app/src/containers/CoworkTodoChip.tsx | C |
| Task dock presentation | LobeHub | src/features/TaskDock/presentation.ts | I |
| Sub-agent run rows, replay | Jan | web-app/src/containers/CoworkTasksPanel.tsx | C |
| Grouped task list | ZCode | packages/ui/src/TaskList*.tsx, workspace-grouped-tasks | C |
| Scheduled tasks | T3 Code | apps/server/src/scheduledTasks | C |

### Changes
| Pattern | Source | Path | Lic |
|---|---|---|---|
| Per-path turn summary | ZCode | packages/services/src/session/taskChangeSummary.ts | C |
| Edited files derived from results | LobeHub / Roo | deriveEditedFiles.ts / fileChangesFromMessages.ts | I / C |
| Review scopes + size gate | ZCode | packages/ui/src/GitPane.tsx, GitPane/helpers.ts | C |
| Rewind preview safe/unsafe/ignored | ZCode | ConversationFileRewindDialog.tsx | C |
| Per-hunk keep/discard "N of M" | assistant-ui | reviewable-diff.tsx | C |
| Diff comments as prompt, stable diff refs | monocode | src/features/source-control/model/diffComment.ts, stableDiff.ts | C |
| Checkpoint before restore | Opcode | src-tauri/src/checkpoint, TimelineNavigator | I |
| Checkpoint storage tricks | Cline / T3 | per-session GIT_INDEX_FILE / hidden refs (apps/server/src/checkpointing) | C |

### Folders
| Pattern | Source | Path | Lic |
|---|---|---|---|
| Pure model, sticky folders, tested | OpenCode | packages/app/src/components/file-tree-v2-model.ts | C |
| Watch only expanded dirs, generation counter | ZCode | packages/ui/src/workspace-file-tree/useWorkspaceFileTreeData.ts | C |
| Collapsed single-child chains | LobeHub | WorkingSidebar/Files/useCollapsedDirectoryChildren.ts | I |
| Refresh debounce 150 ms + refreshAgain | monocode | src/features/files/model/fileTree.ts | C |
| Tree file dragged to composer | T3 Code | apps/web/src/components/files/fileTreeDragMention.ts | C |
| Shared right-rail shell | Jan | web-app/src/containers/CoworkSidePanel.tsx | C |

### Sessions
| Pattern | Source | Path | Lic |
|---|---|---|---|
| Thread list / remote thread list | assistant-ui | packages/core/src/runtimes (remote-thread-list) | C |
| Task history persistence | Roo Code | src/core/task-persistence (archived repo) | C |
| Worktree/session managers | Crystal | main/ (stale, rebranded) | C |
| Session browser, timeline | Opcode | src/components | I |
| Import external agent JSONL (parentUuid/tool_use_id pitfalls) | LobeHub | packages/heterogeneous-agents/src/transcript/claudeCode.ts | I |

## 4. Completeness critic

Mark legend: [NOT READ] not examined; [NO EVIDENCE] category claimed without evidence; [UNVERIFIED] claim not checked; [WRONG] contradicted.

### Apps and sources
- [NOT READ] The survey's clone step shallow-cloned 15 repos; directory lists "come from name-based find passes, not deep reading". Goose UI, Cherry Studio, Vercel AI Elements and Streamdown dirs were named as least verified. Nothing in the evidence shows file-level reading for those four. Several Goose and ZCode paths above are marked unconfirmed for that reason.
- [NOT READ] Closed-source apps were excluded by design (Claude Code, Cursor, Codex app, Zed, Windsurf, Warp). Their UX is the usual benchmark for a "first-class AI tool"; no evidence was gathered. Also absent: Zed, Continue, Aider, OpenHands, Kilo Code, Cursor-like forks, Claude Squad/Conductor-style worktree managers, Void, Msty, LM Studio, Open WebUI, AnythingLLM. Not claimed absent from the user's list, simply not surveyed.
- [UNVERIFIED] "monocode = hardbeat920/monocode" is a medium-high confidence resolution; the user's "monocode" may be a different project. "zcode" resolution assumed Z.ai.
- [UNVERIFIED] ZCode's NOTICE files were flagged "check before copying code" and not checked. Anything copied from ZCode needs that check; this plan says re-write, not copy.
- [UNVERIFIED] Licence classification came from LICENSE files only. Per-file headers, vendored third-party code (T3 `.repos/`) and dependency licences (ansi-to-react BSD-3) were not audited.
- [NOT READ] The user's request names "transcript" in a second sense (conversation transcript import/export, task/changes/folder bookkeeping). Import of external agent JSONL (LobeHub) and export (OpenCode) are listed only as runner-up patterns and were not read in depth. No evidence on how any app indexes/searches saved sessions across projects or organises session folders on disk.

### Categories without or with thin evidence
- [NO EVIDENCE] Accessibility (screen-reader behaviour of tool-call disclosures, tree ARIA, toast live regions beyond Base UI's API list).
- [NO EVIDENCE] Performance numbers in a real Electron window: no app was run. The only timing is Node SSR (react-markdown vs streamdown), which says nothing about block memoisation, scrolling, or content-visibility. Bundle sizes for Wave 6 (ansi-to-react, shiki fence path) are unmeasured.
- [NO EVIDENCE] Windows behaviour of every candidate: win32 binaries were inventoried only, not run; none loaded under Electron 44. fs.watch recursive behaviour on Windows/NTFS and `/mnt` was asserted from docs, not tried.
- [NO EVIDENCE] Mobile/web variants (T3 apps/mobile, ZCode web client) and remote-access UX were out of scope.
- [NO EVIDENCE] Settings, onboarding, model picker, permissions/approval dialogs, notifications, auto-update UX, i18n, theming across apps. The survey covered the six areas the user named plus infrastructure only.
- [NO EVIDENCE] Per-hunk accept/reject apply path (assistant-ui) and git worktree UX (T3, Crystal) were named but not studied; Namzu worktree handling was not compared.
- [NO EVIDENCE] Memory/long-thread behaviour (10k-message sessions), and Windows IME in the composer for any candidate.

### Claims not verified
- [UNVERIFIED] The synthesis' per-app package/version tables are "as declared" in package.json, not confirmed in lockfiles or source use.
- [UNVERIFIED] Base UI 1.4.1 Toast visuals/stacking: only exports were checked in Node. Base UI 1.4.1->1.8.0 diff unread.
- [UNVERIFIED] @pierre/diffs 1.3.0-beta.10 -> 1.5.2 breaking changes; that @pierre exposes a reusable shiki highlighter; worker-pool under Namzu's CSP.
- [UNVERIFIED] `@parcel/watcher` and `@lydell/node-pty` prebuilds being N-API (Electron ABI independent). `@vscode/ripgrep` asar-unpack path.
- [UNVERIFIED] "@formkit/auto-animate ~2 KB / 3 kB": not installed or measured. "@streamdown/code 2.0.0 compat": not checked (moot, streamdown not adopted).
- [UNVERIFIED] Whether the transcript has a real long-thread problem. The trial found none measured.
- [UNVERIFIED] The updater claims in section 1 come from reading `research/desktop-delivery-20261007/README.md`; I did not run `native-update.cjs` or `snapshot-modules.mjs`, and did not check that `packages/desktop` main code today imports only `ws`+`yaml`+`ignore` (the README states those three).
- [WRONG, fixed above] remend adoption, sonner adoption, streamdown trial (see section 0).
- [UNVERIFIED] The wave file paths are from the directory listing of `packages/desktop/src/renderer`; I did not open `message.tsx`, `tool-view.tsx` or `app.tsx` to confirm every named symbol (`noticeTimer`, `MarkdownBody`) beyond what the trial report states. Treat file lists as starting points.
- [UNVERIFIED] Overlap with the uncommitted work in the tree (file-panel, panel-tabs, checkpoints) was not diffed; waves 4 and 8 depend on that work landing first.

### Suggested follow-ups to close the gaps (not done)
1. Real-Electron profile of a 300-turn transcript before wave 3 (also decides virtualisation).
2. Deep read of ZCode (NOTICE), Goose UI, AI Elements component sources, Cherry Studio file tree.
3. One-day survey of Zed/Continue/Kilo/OpenHands/Aider and the worktree managers.
4. Run the three native packages inside Electron 44 on the Windows install before any wave 5b/5c.
