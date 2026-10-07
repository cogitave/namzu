# Namzu Desktop package landscape synthesis (2026-10-07)

Apps surveyed (14): T3 Code, monocode, ZCode, OpenCode, Goose, Opcode, Crystal, Cline, Roo Code, Cherry Studio, LobeHub, Jan, assistant-ui, Vercel AI Elements.
npm metadata from `npm view` on 2026-10-07 (no installs). Namzu today read from packages/desktop/package.json and src/renderer.

Licence warnings for copying code (packages are fine, source is not): Opcode AGPL-3.0, Cherry Studio AGPL-3.0, LobeHub (Apache + commercial-derivative clause, not OSI). Ideas only from those three. T3, monocode, OpenCode, Crystal, assistant-ui = MIT; ZCode, Goose, Cline, Roo, Jan, AI Elements = Apache-2.0.

Namzu today (desktop deps): react-markdown 10.1 + remark-gfm + remark-frontmatter, @pierre/diffs 1.3.0-beta.10 (npm now 1.5.2), @headless-tree 1.7.0, @tanstack/react-virtual 3.14.13 (used ONLY in file-panel/file-tree.tsx and changes-review/tree.tsx; transcript.tsx, 489 lines, is NOT virtualized), fuzzysort 4.0.2, ignore, yaml, lucide-react 0.564, @base-ui/react 1.4.1, hand-rolled use-transcript-scroll.ts (103 lines, 48px follow threshold, explicit-jump flag, follow ref), hand-rolled command-palette.tsx (204 lines + command-palette-filter.ts), hand-rolled conversation-tasks.tsx (199 lines), turn-changes.ts + turn-changes-card.tsx, changes-review/*, hand-rolled shortcut dispatcher (conversation-actions.ts; tinykeys, react-hotkeys-hook, simple-git, isomorphic-git already evaluated and KEPT as ours in research/package-evaluation-20261007). No toast lib, no xterm, no motion lib (CSS: transcript-motion.css/ts), no state lib (state.ts + stores). No watcher dependency visible in desktop package.json.

## 1. Per-category comparison

Format: apps using (count) | packages+versions | licence / maintenance (npm modified) / React 19 / size | Namzu today | verdict.

### transcript-markdown
- Streamdown family: monocode, ZCode, Cline(hub/ui), Cherry, Jan, AI Elements, assistant-ui(optional) = 7 apps. streamdown ^2.4-2.5 (npm 2.7.0, 2026-09-30, Apache-2.0), @streamdown/code (npm 2.0.0 now; apps pin 1.x, check major bump), /math /mermaid /cjk. React 19 fit yes. Bundles shiki + mermaid lazily via plugins; core is moderate, mermaid/katex heavy but lazy.
- react-markdown 10: T3, Goose, Crystal, Opcode(9), Roo(9), LobeHub, Jan(fallback), Cline(old webview), assistant-ui = 9 apps. MIT/unified, React 19 ok.
- Hardening: rehype-harden (monocode, assistant-ui, Streamdown), rehype-sanitize+dompurify (T3, Goose-ish).
- Namzu: react-markdown 10 + gfm + frontmatter, memo(MarkdownContent/MarkdownBody) in message.tsx.
- Verdict: KEEP react-markdown as the renderer (Namzu has custom workspace link handling, frontmatter; T3, the best-engineered app, also stays on it with stable component map, memoised plugin arrays). ADOPT remend (1.4.0, Apache-2.0, 2026-09-30, tiny) to heal the unterminated tail block before react-markdown: this gives the Streamdown benefit without switching renderer. Trial 1: remend + block split (marked.lexer, as OpenCode/Cline). Trial 2: streamdown 2.7 in mode="streaming" for the live message only, static for history (ZCode found streaming mode on finished messages caused a React #185 loop; keep static for history). Pitfall list from ZCode: explicit remarkPlugins replace Streamdown defaults; its link hardening blocks file://. Mermaid: ADOPT lazily later (mermaid ^11, render only after stream settles, T3).

### streaming
- remend (OpenCode, assistant-ui), @shikijs/stream (OpenCode), partial-json (Cherry, LobeHub; npm 0.1.7 last modified 2024-05, stale but tiny), @streamdown (above), @streamparser/json (Cline), secure-json-parse (assistant-ui).
- Namzu: none (re-renders whole body, memo only).
- Verdict: ADOPT remend (see above). Pacing ideas without a package: T3 server-side release only up to blank line/closed fence; Goose 50 ms throttle (useThrottledStreamingText); monocode word-fade pacing. Cheapest first trial: 50 ms throttle + stable component map. partial-json: only if Namzu renders streaming tool arguments (KEEP/skip otherwise).

### autoscroll
- use-stick-to-bottom ^1.1.3-1.1.6 (npm 1.1.6, MIT, 2026-06-04): ZCode (simple variant), Cline hub, Jan, AI Elements = 4 apps. Hand-rolled follow state machines: T3, OpenCode, Goose, Roo (3 phases), Cherry (2 modes), assistant-ui, monocode, LobeHub, Crystal, Opcode = 10 apps. Observation: every serious app outgrew the library.
- Namzu: use-transcript-scroll.ts hand-rolled (follow ref, explicit jump, 48px threshold, away state).
- Verdict: KEEP ours (it already has the user-intent model; library cannot do per-session restore, disclosure pause, prepend anchoring). Fill gaps from patterns: pause follow when a disclosure opens (assistant-ui, Cherry), ignore programmatic scroll events (OpenCode markAuto), per-session remembered position with atEnd flag (T3, Cherry), ResizeObserver re-pin same frame. Do not adopt use-stick-to-bottom except as a throwaway trial for inner scroll boxes (thinking panel).

### virtualization
- @tanstack/react-virtual: ZCode, Opcode, assistant-ui example, OpenCode(solid), Jan(hub only), Namzu(trees) ; npm 3.14.13 (2026-09-14, MIT). React-virtuoso: Cline, Roo, LobeHub (lists) ; 4.18.16, MIT, 2026-09-29. virtua: Cherry, LobeHub (transcript) ; 0.53.3, MIT, 2026-10-06, ~3 kB, has `shift` for prepend and keepMounted. @legendapp/list: T3 (patched) ; 3.6.0, MIT. No virtualization: Goose (chunked mount), monocode (CSS content-visibility:auto + paging), Crystal, Jan (transcript), AI Elements.
- Namzu: transcript unvirtualized; trees use react-virtual.
- Verdict: ADOPT for transcript only when conversation size demands; first try the no-dependency step: content-visibility:auto with contain-intrinsic-block-size on off-screen turns (monocode) plus paged history. If a real virtualizer is needed: Trial 1 virtua (small, prepend-safe, React 19, used by two transcript apps), Trial 2 @tanstack/react-virtual (already a dependency; ZCode's stable-key height cache + scroll-adjust policy pattern; needs more custom code). Keep react-virtual for trees (KEEP).

### code-highlight
- shiki ^3-4 (npm 4.5.0, MIT): monocode, ZCode, OpenCode (worker), Cline, Roo, Cherry, LobeHub, Jan, AI Elements, T3 (via @pierre/diffs) ; Prism react-syntax-highlighter: Goose, Opcode, assistant-ui.
- Namzu: shiki inside @pierre/diffs; code blocks in markdown (check message.tsx for plain pre; markdown-code-copy.ts exists).
- Verdict: KEEP shiki via pierre; ADOPT (new, small) shiki highlighting for transcript code fences with a singleton highlighter + LRU keyed code+lang+theme, none while streaming (T3, Jan StreamingCode). Trial: @pierre/diffs File component for fences vs shiki direct (codeToHast). Off-main-thread worker (OpenCode) only if jank measured.

### diff
- @pierre/diffs: T3, ZCode, OpenCode, Cline, Cherry, LobeHub(PatchDiff via @lobehub/ui), Namzu = 7 apps ; npm 1.5.2 (2026-10-05, Apache-2.0). Others: diff (jsdiff 8-9: 8 apps), parse-diff (assistant-ui), @codemirror/merge, Monaco DiffEditor (Crystal), custom UnifiedDiffView (monocode).
- Namzu: @pierre/diffs 1.3.0-beta.10 (behind: 1.5.2 stable).
- Verdict: KEEP @pierre/diffs; UPGRADE to 1.5.2 (T3 patches 1.5.2; ZCode adds worker pool and a size gate). Adopt patterns: worker pool (@pierre/diffs/worker), rich-diff size gate (>180k chars or >1200 lines falls back to patch/plain, ZCode), Cline's StrictMode blank-render watchdog check, annotations for line comments. Add `diff` (jsdiff) only if intra-line word highlights are needed outside pierre.

### editor
- Composer: Tiptap (T3, Cherry) , Lexical (ZCode), plain textarea-autosize (Roo, Cline, Jan, Cherry-lite). File editor: CodeMirror 6 (monocode, Cherry), Monaco (Crystal), @uiw/react-md-editor (Opcode).
- Namzu: composer.tsx hand-built input (composer-input.ts); file-view is read-only preview.
- Verdict: KEEP composer; trial Tiptap 3.31 (MIT, 2026-09-30) only if inline chips/mentions are wanted (T3); heavy. File editing: defer; if wanted, CodeMirror 6 (codemirror 6.0.2, @codemirror/merge 6.12.2, MIT) is the lighter choice vs Monaco (large workers/Electron CSP cost).

### terminal
- @xterm/xterm 5.5-6.0 (npm 6.0.0, MIT, 2026-08-30; xterm, addon-fit 0.11.0): monocode, ZCode, Crystal, LobeHub; node-pty/@lydell/node-pty: T3, ZCode, OpenCode, Crystal. Output-only ANSI: ansi-to-react (ZCode, Cline hub, Cherry, AI Elements; 6.2.6, BSD-3, 2026-04), ansi-to-html (Opcode, Crystal, Roo), anser (LobeHub), strip-ansi (OpenCode).
- Namzu: none in desktop (CLI has its own TUI). Tool output rendering in tool-view.tsx.
- Verdict: ADOPT ansi-to-react (or anser) for colored bash tool output now (cheap). Interactive PTY terminal: defer; if built, xterm 6 + addon-fit + @lydell/node-pty (prebuilt; verify Windows). Trial: ansi-to-react vs anser (anser has no React wrapper, smaller).

### file-tree
- @pierre/trees 1.0.0-beta.6 (Apache-2.0, 2026-08-22): T3, OpenCode, LobeHub = 3 apps. Hand-built flat-model + virtualizer: OpenCode (pure model, tested), ZCode, Cherry (TreeView/flattenTree), Cline, AI Elements (non-virtual). ignore: ZCode, Cherry, Cline. Icons: react-material-icon-theme 1.2.0 (monocode; MIT), @iconify-json/material-icon-theme (Cherry), vscode-material-icons (Roo).
- Namzu: @headless-tree 1.7.0 + react-virtual, ignore, custom file-icons.tsx.
- Verdict: KEEP (Namzu already matches ZCode/Cherry architecture). Trial @pierre/trees 1.0.0-beta.6 only for the changes tree (built-in git status overlay, shared by T3 DiffFileTree/ChangedFilesTree, LobeHub) alongside pierre diffs; beta, so risk. Trial react-material-icon-theme for icons only if file-icons.tsx coverage is thin.

### file-watch
- chokidar 4-5 (Cline, Cherry; npm 5.0.0, MIT, 2026-05-21), Node fs.watch recursive (Crystal, Roo), stat-polling of open paths (monocode), per-directory watcher diffing with generation counter (ZCode), @parcel/watcher 2.6.0 (none; native prebuilds).
- Namzu: not found in desktop main (verify; file-panel refreshes on focus/agent writes?).
- Verdict: ADOPT a debounced model, not necessarily a package: refresh cached dirs on agent write + window focus (monocode 150 ms, refreshAgain flag), watch only expanded dirs (ZCode). Package trial: chokidar 5 (pure JS, handles Windows quirks) vs native fs.watch recursive (Node 22 stable on Windows/macOS, Linux recursive since Node 20). WSL/NTFS caveat: fs.watch unreliable on /mnt; keep poll fallback.

### git
- simple-git 3.36-4.0.2: Cline, Roo. execSync/git CLI: Crystal. isomorphic-git: none of the apps. T3: hidden git refs for checkpoints via VCS driver. Roo: shadow repo with core.worktree. Cline: persistent GIT_INDEX_FILE scratch dir.
- Namzu: execFile git (desktop-host-header.ts); simple-git and isomorphic-git already rejected with evidence (unsafe-plugin guard rejects fsmonitor/env hardening).
- Verdict: KEEP. Copy patterns for checkpoints: Cline's per-session GIT_INDEX_FILE and stat-cache reuse, T3 hidden refs, ZCode file rewind preview (safe/unsafe/ignored files). The in-flight packages/cli/src/checkpoints work already matches this.

### search
- fuzzysort 3.1-4.0.2 (OpenCode, Roo-CLI, Namzu), fzf 0.5.2 (Cline, Roo, Jan; BSD-3, last modified 2023-04, stale), fuse.js 7 (Cline, Jan, LobeHub), @ff-labs/fff-node (T3), @codemirror/search, ripgrep (@vscode/ripgrep, Roo CLI). In-transcript find: ZCode (indexed), monocode, T3.
- Verdict: KEEP fuzzysort (current, 4.0.2). ADOPT in-transcript find as a feature (own index + DOM highlight, ZCode/monocode patterns; CSS Highlight API avoids DOM mutation). Full-workspace entry index fetched once instead of walking lazy tree (ZCode) for file search.

### tasks-todos
- Todo derived from TodoWrite tool input: monocode, Opcode, Crystal, Cherry, Roo, LobeHub, Jan (phases), assistant-ui TodoList/AgentPlan, AI Elements Queue. Durable: Cline (SQLite schema, approval, runs), ZCode (node:sqlite), LobeHub (DB, TaskDock), croner for cron (ZCode, Cherry). OpenCode: minimal row.
- Namzu: conversation-tasks.tsx (199 lines, test) + job-row.tsx + sidebar-background-work.
- Verdict: KEEP ours; fold in UI patterns (section 2). croner (^10, MIT) is the choice if scheduled automations need a UI cron parser (CLI scheduled-tasks is its own).

### command-palette
- cmdk 1.1.1 (MIT, last modified 2025-08, stale but stable): ZCode, Cline hub, Cherry, LobeHub, Roo, assistant-ui, AI Elements = 7 apps. T3 hand-built (CommandPalette.logic.ts); OpenCode fuzzysort + own.
- Namzu: hand-built command-palette.tsx + filter (tested), fuzzysort, base-ui.
- Verdict: KEEP (cmdk does its own filtering that conflicts with fuzzysort ranking, and base-ui already supplies dialog/combobox; ui/combobox.tsx exists). Revisit only if a11y gaps found.

### toasts
- sonner 2.0.8 (MIT, 2026-08-09): Cline hub, Jan, assistant-ui, AI Elements. solid-sonner (OpenCode), react-toastify (Goose), Radix toast (Opcode).
- Namzu: none in package.json (chat-error-banner.tsx inline). Base UI has a Toast primitive in the base-ui version family (verify in 1.4.1 before adding anything).
- Verdict: ADOPT sonner 2.0.8 if base-ui toast absent or too bare (React 19 fine, ~10 kB). Use for undo notices (T3 SidebarThreadUndoNotice pattern), copy confirmations, rollback results.

### panels-layout
- react-resizable-panels 3.0.6-4.14.2 (MIT, 2026-10-02): ZCode, Cherry, Jan, assistant-ui, AI Elements. react-rnd (LobeHub floating). Jan custom right-rail shell with pointer capture, double-click reset, persisted width (CoworkSidePanel). OpenCode: session-panel-layout/width pure modules.
- Namzu: file-panel/panel-tabs.tsx + css, custom.
- Verdict: KEEP custom unless drag/min/max keyboard a11y becomes a burden; Trial 1 react-resizable-panels 4.14 (v4 API; ZCode/Cherry use 4.x); Trial 2 keep ours and copy Jan's rules (clamp 240..70%, body pointer-events-none while resizing, double-click reset, persisted width).

### motion
- motion 12.x (npm now 14.0.0; MIT): ZCode, OpenCode, Cline, Cherry, LobeHub, Jan, AI Elements; framer-motion (Goose, Opcode). @formkit/auto-animate 0.10.0 (T3, LobeHub; 3 kB). tw-animate-css (ZCode, OpenCode, Jan).
- Namzu: CSS + transcript-motion.ts, sidebar-motion.ts, effort-shader (WebGL).
- Verdict: KEEP CSS (smaller, already tested). Trial @formkit/auto-animate for list add/remove only (sidebar, task lists). Skip motion/framer (bundle cost; not needed). Respect prefers-reduced-motion (T3).

### state
- zustand 5.0.15: ZCode, Crystal, Opcode, Cherry, LobeHub, Jan, T3, assistant-ui = 8. swr (ZCode, Goose, Cherry, Jan, LobeHub), @tanstack/react-query (Roo, LobeHub), effect (T3, OpenCode), hand-rolled stores + useSyncExternalStore (monocode). better-sqlite3/node:sqlite persistence (Crystal, Cherry, ZCode, Cline).
- Namzu: hand-rolled state.ts + stores (monocode-like).
- Verdict: KEEP. Adopt monocode/T3 discipline: pure sibling .logic modules with tests (Namzu already follows), stable references on update (reuseUnchangedById, TranscriptTurnCache). zustand only if selector re-render cost shows up.

### keyboard
- react-hotkeys-hook (Cherry, LobeHub), tinykeys (none among apps; Namzu rejected), solid-list (OpenCode), @opentui/keymap (OpenCode TUI), hand-rolled elsewhere.
- Namzu: hand-rolled; tinykeys/react-hotkeys-hook REJECTED (AltGr, IME). @tanstack/hotkeys 0.11 only credible, pre-1.0.
- Verdict: KEEP; revisit @tanstack/hotkeys at 1.0 (keep keyCode 229 guard).

## 2. Recommendation table

| Category | Verdict | Trial candidates |
|---|---|---|
| transcript-markdown | KEEP react-markdown; ADOPT remend; mermaid lazy later | remend; streamdown 2.7 (live message only) |
| streaming | ADOPT | remend + 50 ms throttle; marked.lexer block split |
| autoscroll | KEEP ours, add gaps | none (patterns: disclosure pause, markAuto, per-session memory) |
| virtualization | ADOPT (transcript, on demand) | content-visibility first; virtua 0.53; @tanstack/react-virtual |
| code-highlight | KEEP shiki; ADOPT fence highlighting | shiki singleton+LRU; @pierre/diffs File |
| diff | KEEP @pierre/diffs, UPGRADE 1.5.2 | worker pool; size gate |
| editor | KEEP; defer file editing | Tiptap (chips); CodeMirror 6 |
| terminal | ADOPT ansi output | ansi-to-react; anser; later xterm 6 |
| file-tree | KEEP | @pierre/trees for changes tree |
| file-watch | ADOPT behavior | native recursive fs.watch; chokidar 5 |
| git | KEEP | none |
| search | KEEP fuzzysort; ADOPT transcript find | CSS Highlight API |
| tasks-todos | KEEP + UI patterns | croner (only for cron UI) |
| command-palette | KEEP | none |
| toasts | ADOPT | sonner 2.0.8 (verify base-ui toast first) |
| panels-layout | KEEP | react-resizable-panels 4.14 |
| motion | KEEP CSS | @formkit/auto-animate |
| state | KEEP | none |
| keyboard | KEEP | @tanstack/hotkeys at 1.0 |

REPLACE (ours -> package): none recommended. Evidence: the two most comparable apps (T3, ZCode) keep hand-rolled scroll, palette, shortcuts, and file model; Namzu's rejections already have trials.

## 3. Ten UI/UX patterns to copy

1. Transcript: Streaming markdown shape control: release text only up to blank line/closed fence/list start (T3 apps/server/src/orchestration-v2/assistantStreaming.ts), plus stable component map and memoised plugin arrays (apps/web/src/components/ChatMarkdown.tsx).
2. Transcript: Block-level streaming: marked.lexer splits text, only the tail is "live" and healed with remend (OpenCode packages/session-ui/src/components/markdown-stream.ts; Cline MarkdownBlock.tsx).
3. Transcript: Follow mode as explicit state with user-intent escapes (wheel up, key, drag, row expansion) and hydration window on thread switch (Roo webview-ui/src/hooks/useScrollLifecycle.ts; Cherry components/chat/messages/list/useViewportFollowState.ts); pause follow on disclosure expand (assistant-ui packages/react/src/primitives/thread/useThreadViewportAutoScroll.ts).
4. Transcript: Pin the sent user message to top with a shrinking spacer (LobeHub src/features/Conversation/ChatList/hooks/useConversationScroll.ts; T3 ChatView.tsx anchoredEndSpace).
5. Transcript: Streamdown mode per message: streaming only for the live message, static for finished (ZCode packages/ui/src/components/ai-elements/message.tsx resolveMessageStreamdownMode), with an error boundary falling back to plain text.
6. Tasks: Composer-attached progress tray: collapsed shows only the in-progress item, counter completed/total, ring or segmented bar, auto-center active item (Roo TodoListDisplay.tsx; LobeHub src/features/Conversation/TodoProgress/index.tsx; T3 ComposerTasksBadge.tsx). Normalise statuses (monocode src/features/sessions/model/taskList.ts); chip renders null until data exists (Jan CoworkTodoChip.tsx).
7. Tasks: Background-work dock with pure presentation helpers: DockTask {status, progress, group, cancel/retry}, auto-dismiss success only (LobeHub src/features/TaskDock/presentation.ts); sub-agent run rows with phase, duration, tokens, and replay of finished runs through the same message component (Jan CoworkTasksPanel.tsx).
8. Changes: Per-turn change summary aggregated per path (first before to final after) and derived purely from transcript tool results, skipping pending/failed calls (ZCode packages/services/src/session/taskChangeSummary.ts; LobeHub EditedFilesCard/deriveEditedFiles.ts; Roo fileChangesFromMessages.ts). Review sources unstaged/staged/branch/last-turn (ZCode GitPane.tsx) with size-gated rich diff (GitPane/helpers.ts).
9. Changes: Restore safety: preview rewind classifying safe/unsafe/ignored files before applying (ZCode ConversationFileRewindDialog.tsx), and "current state saved as a new checkpoint" before restore (Opcode TimelineNavigator, idea only: AGPL); per-hunk keep/discard decisions with "N of M kept" (assistant-ui reviewable-diff.tsx); inline diff comments formatted as a prompt (monocode src/features/source-control/model/diffComment.ts); stable-reference refresh so only changed files re-render (monocode stableDiff.ts).
10. Folders: Tree as pure model + flat rows + virtualizer, sticky ancestor folders, git-status styling, collapsed single-child chains, watchers only on expanded dirs, instant remount from cached listDir and refresh on focus/agent write (OpenCode packages/app/src/components/file-tree-v2-model.ts; ZCode packages/ui/src/workspace-file-tree/*; LobeHub WorkingSidebar/Files/useCollapsedDirectoryChildren.ts; monocode src/features/files/model/fileTree.ts). Also drag a tree file onto the composer as a mention (T3 files/fileTreeDragMention.ts).

Runner-up patterns: Jan shared right-rail shell (CoworkSidePanel.tsx); Goose/Cherry transcript export to Markdown as a pure function (OpenCode packages/tui/src/util/transcript.ts); Cline convergent transcript reducer with seq/epoch (messageReducer.ts); T3 tool presentation as pure modules (packages/client-runtime/src/work-log/*); reading external agent JSONL transcripts for import and crash replay (LobeHub packages/heterogeneous-agents/src/transcript/claudeCode.ts, with its listed parentUuid/tool_use_id pitfalls).

## 4. Order of work suggested
1. Upgrade @pierre/diffs to 1.5.2 (stable) and add the size gate.
2. remend + throttle trial on live message.
3. Transcript content-visibility and per-session scroll memory; virtua only if measured need.
4. Per-turn changes aggregation tweaks, restore preview.
5. sonner (after checking Base UI toast).
6. ansi-to-react for tool output.

Caveats: survey facts come from file reads by other agents; versions in apps are as declared. Not verified here: bundle sizes (no installs), Base UI 1.4.1 toast availability, Namzu file-watch implementation (grep of src/main found no watch() call), @streamdown/code 2.0.0 compatibility with streamdown 2.7.
