# @pierre/diffs 1.3.0-beta.10 to 1.5.2, and the rich-diff size gate

Wave 1 of `research/ai-tool-landscape-20261007/PLAN.md`. Proof is `capture.mjs` against the live
preview (`http://127.0.0.1:5173/preview`); its output is `capture-output.txt`, screenshots are in
`artifacts/`.

## Breaking changes read (1.3.0-beta.10 to 1.5.2)

Source: the GitHub release notes of `pierrecomputer/pierre` for every tag in the range, saved as
`release-notes-1.3.0-beta.10-to-1.5.2.txt` (first 2,500 characters of each). Nothing we use broke.

| Version | Change | Affects us |
|---|---|---|
| 1.3.0 | Firefox floor 125+ (Intl.Segmenter) | No, Electron/Chromium |
| 1.3.0 | `MultiFileDiffProps` and the SSR/vanilla render props became unions (added-only or deleted-only files) | No: we pass both `oldFile` and `newFile`, never extend the type |
| 1.4.0 | Editing API reshaped (`new Editor(type, options, key)`, `onEditChange`/`onEditComplete`, `getViewState`, `cleanUp(mode)`) | No: we never edit; `@pierre/diffs/edit` is not imported |
| 1.5.0 | Editing a partial diff throws without `loadDiffFiles` | No: no editing |
| 1.5.1 | New `lineDiffType: 'word-line'` | Not adopted |
| 1.5.2 | Worker pool errors no longer log (`onWorkerError`) | No pool is used |
| deps | `@pierre/theme` 1.1.0 to 2.0.0, `@pierre/theming` 0.0.2 to 1.0.1 (both Apache-2.0) | Themes `pierre-light`/`pierre-dark` still resolve |

Import sites checked: `parseDiffFromFile` (model.ts, changes-totals.ts), `MultiFileDiff`
(diff-pane.tsx), `File`, `CodeView`, `getSharedHighlighter`, `getFiletypeFromFileName`
(file-view.tsx). `pnpm typecheck` shows no error in any of them, and the existing tests pass
unchanged (`unifiedDiff`, hunk counts). `unsafeCSS` (`diff-theme.ts`) and the theme tokens are
unchanged and render correctly in dark and light (screenshots). No local workaround for a beta
bug was found, so none was deleted. `useHighlighterReady` in file-view.tsx still matters: it is
what makes `File` paint on a page that has not drawn a diff yet; I did not test removing it.

## What changed

- `package.json`, `pnpm-lock.yaml`: `@pierre/diffs` `1.5.2` (exact).
- `THIRD-PARTY-NOTICES.txt` entry 14 and `licenses/files-pierre-diffs-*.txt`, listed in
  `scripts/retain-notices.mjs` so they ship. There was no entry for the package before.
  `lru_map` ships no licence text; the notice says so.
- `changes-review/diff-gate.ts` (+ test): limits 180,000 characters (before plus after) and 1,200
  changed lines (added plus removed); lines are checked first.
- `changes-review/diff-pane.tsx`, `review.css`: over the gate the pane shows the plain unified
  patch from the existing `unifiedDiff`, in a monospaced `<pre>` that follows the Wrap toggle,
  under "This diff changes N lines, so it is shown as a plain patch." and a "Show full diff
  anyway" button. The patch is only built once the gate trips. The choice is per file path and
  lasts while the pane stays mounted.
- `src/dev/preview-changes.ts`: a 5,000-line fixture (`src/generated/rate-table.ts`, +5,000 -5,000).
- Pattern from ZCode `GitPane/helpers.ts` (thresholds and the fall-back idea only); the code is written fresh.

## Worker pool: not adopted

`@pierre/diffs/worker` needs a Worker. The renderer CSP is
`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; ...` with no `worker-src`, so a
same-origin worker file could fall back to `script-src 'self'`, but the portable worker is
blob-based and the packaged app loads from a non-http origin that I did not test. That needs a
CSP change and a Windows run, so it is left out as instructed.

## Proof (real Chromium, preview, 1440x900, dark and light)

16 PASS, 0 console errors: normal diff is rich with rows drawn; the 5,000-line change is gated
("10,000 lines"), shows a `--- a/... +++ b/... @@ -1,5000 +1,5000 @@` patch of 10,004 lines in a
monospace font; "Show full diff anyway" swaps in the rich view (7.5 s measured including a 2 s
settle; that is the cost the gate avoids by default); the source view draws
lines. The preview is flaky at tree-row clicks right after a reload, so `capture.mjs` retries
clicks; a failed attempt is never counted as a pass.

Screenshots (`artifacts/`): `01-normal-diff-*`, `02-gated-*`, `03-gate-forced-*`, `04-source-view-*`
for `dark` and `light`.

## Before and after

Before (beta.10) screenshots exist from the earlier review work in
`research/changes-review-20261007/artifacts/` (same preview, same theme CSS). After: the same
rows, gutters, add/delete tints and hunk separators in `01-normal-diff-*`. I did not re-run beta.10
side by side in this pass (the package is replaced in node_modules), so "no visual change" is by
comparison with those earlier images, not a pixel diff. Before the gate a 10,000-changed-line file
was always handed to the rich renderer.
