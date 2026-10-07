# File panel proof (2026-10-07)

Screenshots of the right-hand file panel in the design preview (`http://127.0.0.1:5173/preview`, in-memory sample project from `packages/desktop/src/dev/preview-files.ts`), taken with Playwright Chromium.

| File | Shows |
|---|---|
| `01-wide-dark-markdown.png` | 1500 px wide: tab strip (Changes, Activity, an open file, "+"), breadcrumb pill, View source, tree toggle, "Open" split button, the Metadata table with monospace keys, the rendered document, and the file tree with the open file highlighted. |
| `02-many-tabs-dark.png` | Ten open files: tabs shrink to a 72 px floor and the strip scrolls so the active tab (package.json) is in view next to "+". The filter is empty after opening from quick open, so the tree is back with the file revealed. |
| `03-overlay-899-light.png` | 899 px wide window (overlay mode): the panel now sits above the composer, so no file text runs under it. The breadcrumb keeps the file name; folders shrink first. |
| `04-narrow-760.png` | 760 px window, same checks as 03 with the sidebar collapsed. |
| `05-filter-dark.png` | Quick open with a query: results highlighted, `aria-activedescendant` points at the selected option. |

Measured in the same run: active tab fully inside the strip (`activeVisible: true`), filter value `""` after opening a hit, ArrowLeft on the tab strip moves to the previous file, the resize separator reports `aria-valuenow/min/max` (599/320/1016).

## Security tests (unit, no screenshots)

`packages/desktop/src/main/project-files.test.ts` (72 tests), `operator.project-files.test.ts`, `open-in.test.ts`:

- path confinement table: traversal, absolute, UNC, drive letter, `~`, `file://`, control characters, `.git`, symlinks that leave the root;
- hidden files: `.gitignore` and `.git/info/exclude` matches, `node_modules` and a link to an ignored file are refused by `read()` and never become chat links (this run);
- a named pipe is refused without blocking; an opened file must still resolve to the same inode;
- index caps: path cap inside one folder, depth, injected-clock budget, cache and `invalidate`;
- editors: per-user, Program Files and PATH installs.

Known, documented limit: a folder swapped for an outside link between the confinement check and the open can still win a race; Node has no `openat`-style descent.

## Rerun

```bash
export PATH=$(echo "$PATH" | tr ':' '\n' | grep -v '^/mnt/' | paste -sd:)
cd packages/desktop && pnpm exec vitest run src/main/project-files.test.ts src/main/open-in.test.ts src/main/operator.project-files.test.ts
# with the dev server running, from a scratch dir:
node capture.mjs.txt   # rename to .mjs; set `out` to a folder
```
