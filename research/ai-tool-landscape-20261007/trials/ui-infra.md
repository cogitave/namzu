# UI infrastructure trial (2026-10-07, Node 24.19, npm 11.17, throwaway dir, Namzu repo untouched)

Namzu today: React 19.2.6, Tailwind 4.2.2, @base-ui/react 1.4.1, hand-rolled panel resize handle (`file-panel/panel-tabs.tsx` PanelResizeHandle: pointer capture + ArrowLeft/Right, role=separator, width committed on release), command palette on Base UI Dialog + Autocomplete (204 lines + `command-palette-filter.ts`, IME-safe, custom shortcut chords, grouped, focus return), toast = one `<output class="conversation-action-toast">` fed by `notice` string + 2.5 s timer in app.tsx, CSS transitions (~220 transition/animation/keyframes lines), no motion library.

## Measurements
Install of all 5 + react + react-dom + base-ui: 51 packages, 46M node_modules, 0 vulnerabilities, no `.node`/binding.gyp files, no install/postinstall scripts in any of the candidates (esbuild, used only for sizing, has one; not a candidate).
Bundle = esbuild --minify, react externalised, whole-module import (upper bound; tree-shaking in a real app can only shrink it).

| pkg | version | licence | last publish | du | module | React 19 peer | min / gzip | deps |
|---|---|---|---|---|---|---|---|---|
| cmdk | 1.1.1 | MIT | 2025-08-27 (13 months) | 124K (+radix) | CJS+ESM, sideEffects:false | ^19 ok | 52 KB / 17.9 KB (pulls radix-dialog) | 4 radix |
| sonner | 2.0.8 | MIT | 2026-08-09 | 200K | CJS+ESM | ^19 ok | 34 KB / 9.7 KB | none |
| react-resizable-panels | 4.14.2 | MIT | 2026-10-02 | 920K | ESM (type:module)+cjs | ^19 ok | 56 KB / 19.3 KB | none |
| allotment | 1.20.5 | MIT | 2025-12-19 | 304K | CJS+ESM | ^19 ok | 33 KB / 10.3 KB (+CSS import, 6 deps) | 6 |
| motion (framer-motion 14.0.0) | 14.0.0 | MIT | 2026-10-02 | 908K + 7.0M framer-motion | CJS+ESM, sideEffects:false | ^19 ok | 129 KB / 43.1 KB full; 29.5 KB gz with LazyMotion+`m` | tslib, framer-motion |
| Base UI (current) | 1.4.1 (latest 1.8.0) | MIT | 1.8.0: 2026-09-04 | n/a | CJS pkg w/ exports | ^19 ok | Autocomplete+Dialog 152 KB / 52.5 KB; Toast alone 28 KB gz | floating-ui |

Smoke (node, react-dom/server renderToString, React 19.2.6): cmdk Command/Input/List/Group/Item OK; sonner `<Toaster/>` OK; react-resizable-panels v4 `Group/Panel/Separator` OK (v4 API: `Group`, `Separator`, `orientation`, percent-string sizes, not the v1-3 `PanelGroup`); motion `motion.div` OK; allotment imports (Allotment, LayoutPriority, setSashSize) but needs a CSS file and DOM layout, not render-checked; Base UI Toast exports (Provider, Portal, Viewport, Root, useToastManager, createToastManager...) OK. Not tested: real DOM behaviour (drag, IME, focus) because no browser harness was run; those claims below are from API/dep inspection only.
Tailwind v4 fit: none of them require Tailwind or a plugin; all are unstyled or ship their own CSS (sonner injects CSS at runtime, unstyled via `unstyled`/classNames; allotment needs its CSS import). Electron/Windows delivery: all pure JS, no native binaries.

## Correction to the earlier synthesis
Base UI 1.4.1 (already installed in Namzu) DOES ship a Toast primitive (`@base-ui/react/toast`, with a manager, stacking, swipe, limit, a11y live region). The synthesis said that was unconfirmed; it is now confirmed.

## Verdicts

**Command palette: KEEP Base UI. Do not adopt cmdk.** cmdk is the same shape (Dialog + filtered list) but last published 13 months ago, pulls Radix (a second headless-primitive family next to Base UI, +18 KB gz) and its built-in scorer would replace `matchesCommandQuery` (multi-term across label/group/meta/keywords) and the exact-modifier shortcut logic, both of which have unit tests. The existing code already handles IME composition and Home/End which cmdk handles less explicitly. Only improvement worth taking: fuzzysort ranking (already a dep) instead of Base UI `contains`, via the `filter` prop. Integration: none.

**Toasts: ADOPT Base UI Toast, not sonner.** Today's single-string `notice` loses overlapping messages and has no action/undo button (needed for turn-undo and "retry"). Base UI Toast is already in the installed package (0 new deps, shares floating-ui chunk, 28 KB gz standalone, less when shared), matches Namzu's style system and a11y conventions, and supports multiple stacked toasts, timeouts, action buttons and `createToastManager()` for calling from non-React code (e.g. IPC event handlers). sonner (9.7 KB gz, MIT, active) is the fallback if Base UI's stacking visuals prove too much CSS to write; it would be a second styling system and needs `unstyled` mode to match tokens. Integration shape: `<Toast.Provider><Toast.Portal><Toast.Viewport>` once in app.tsx replacing the `<output class=conversation-action-toast>`; a `notify(text, {action})` helper replacing `setNotice` + `noticeTimer`; keep `aria-live`. Replace the CSS `.conversation-action-toast` with viewport styles above the composer (offset by `--composer-height`).

**Resizable panels: KEEP hand-rolled handle for the side panel; TRIAL react-resizable-panels 4.14.2 only if a second split appears.** The one real use is a single right-side pixel-width panel with commit-on-release persistence, a max computed from the window and `data-panel-resizing` to suppress the width transition; that is ~60 lines and works. RRP v4 is maintained (published 5 days ago), dependency-free, ESM, React 19 OK, 19 KB gz, and does keyboard + persistence + percent/px sizes, so it pays off if Changes view/terminal/tree become multi-pane splits. allotment: skip (VS Code-style but CSS dependency, 6 deps, older publish, DOM-measure based). Integration if triggered: `Group` around main+aside with `Panel` `minSize`/`maxSize` in px strings, `Separator` styled via `data-separator`; onLayoutChanged persists.

**Motion: KEEP CSS; do not adopt now. If layout animations are wanted (tab reorder, list insert/exit, conversation reordering), adopt `motion` with `LazyMotion`+`m` (29.5 KB gz) scoped to those components.** Namzu has no JS animation need today; 43 KB gz full is not justified by fades Tailwind/CSS already do. Real motion value is AnimatePresence exit animations and layout/reorder; @formkit/auto-animate (~2 KB) is the cheaper first trial for lists. Respect `prefers-reduced-motion` (`MotionConfig reducedMotion="user"`).

## Order
1. Base UI Toast in app.tsx (replace notice). 2. fuzzysort in palette filter (optional). 3. Revisit RRP/motion only when a concrete feature needs them. Also: Base UI is 1.4.1 and 1.8.0 exists; upgrade deliberately (not trialled here: the 1.4.1 to 1.8.0 diff was not read).

Evidence dir: /tmp/claude-1000/-home-arda-workspaces--cogitave-cogitave-namzu/0d0f912a-dd18-5fc4-9977-f6f97da58605/scratchpad/landscape/trials/ui-infra/ (smoke.mjs, smoke2.mjs, e/*.jsx, e/out/*).
