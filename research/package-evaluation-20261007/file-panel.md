# Namzu Desktop file panel: package evaluation (2026-10-07)
Trials: this directory (t.mjs, f.mjs). `npm audit` over all candidates: clean for ignore, yaml, fuzzysort, fzf, ufuzzy, fuse.js, launch-editor, headless-tree. Vulnerable: globby/fast-glob/micromatch/braces (high, ReDoS/stack DoS), gray-matter and front-matter (js-yaml 3 -> argparse -> sprintf-js, moderate).

## Picks
| Need | Pick | Notes |
|---|---|---|
| 1 gitignore listing | `ignore@7.0.12` + `node:fs` readdir | 0 deps, 132KB, MIT, ESM+CJS, modified 2026-10-02 |
| 2 frontmatter | `yaml@2.9.1` (parse the `---` block ourselves) | 0 deps, ISC, maxAliasCount default 100 |
| 3 open in editor | none; hand-rolled allowlisted `execFile`; Electron `shell.openPath`/`showItemInFolder` | see below |
| 4 tree UI | `@headless-tree/core@1.7.0` + `@headless-tree/react@1.7.0` (+ a virtualizer) | |
| 5 fuzzy filter | `fuzzysort@4.0.2` | |
| 6 view source | `@pierre/diffs` `File` (already shipped, 1.3.0-beta.10) | no new dep |

## 1. Gitignore-aware lazy listing
Candidates: `ignore` 7.0.12 (MIT, 0 deps), `globby` 16.2.4 (7 deps, audit HIGH via fast-glob/micromatch/braces; walks, not lazy), `fast-glob` 3.3.3 (last modified 2025-01, same advisories), `@nodelib/fs.walk` 3.0.1 (modified 2024-12, a walker only, no ignore semantics).
Globbing libs are the wrong shape: they walk the tree. A lazy tree needs one `readdir` per expanded folder plus a matcher. `ignore` is exactly the matcher (it is also globby's engine) and is spec-correct (negation, anchoring, dir-only rules).
Trial (t.mjs): root `.gitignore` = `dist/`, `*.log`, `!keep.log`; `a/.gitignore` = `/secret`, `*.tmp`. Listing results: root -> `.gitignore, a, keep.log` (dist, z.log, node_modules, .git hidden); `a` -> `.gitignore, b` (secret hidden); `a/b` -> `y.ts` (x.tmp hidden). Correct, nested rules scoped to their directory.
Integration shape (main process): `listDir(dir)` = `readdir(withFileTypes)`; for each directory from the project root down to `dir`, load its `.gitignore` into an `ignore()` instance (cache per dir, invalidate on mtime/watch); entry is hidden if any ancestor instance ignores the path relative to that ancestor (append `/` for dirs); hard-hide `.git` and `node_modules` before any matching. Also read `.git/info/exclude` and optionally the global excludes file at root. Cost is O(entries in the one folder) per open. Windows: always convert to `/` relative paths before `ignores()` (`ignore` throws on `\`/absolute paths; v7 handles win32 conversion only when `path.win32` form is passed, so normalise yourself).
Risks: nested-ignore of already ignored parent dirs is naturally handled (we never descend into hidden dirs unless the user "shows ignored"); no `core.excludesFile` unless read explicitly. Alternative for exactness: `git check-ignore --stdin -z` batch via execFile (needs git, exact semantics incl. global config). Not needed for v1.

## 2. YAML frontmatter -> metadata table
| pkg | version | modified | deps | engine | verdict |
|---|---|---|---|---|---|
| yaml | 2.9.1 | 2026-09-11 | 0 | YAML 1.2, no code tags | pick |
| gray-matter | 4.0.3 | 2023-07 | 4 (js-yaml 3) | | REJECT |
| front-matter | 4.0.2 | 2023-07 | 1 (js-yaml 3) | | no |
| vfile-matter 5.0.1 | 2025-03 | vfile + yaml | wrapper over yaml | only useful inside a unified pipeline |
| remark-frontmatter 5.0.0 | 2023-11 | | detects/hides the block in react-markdown; does not parse |
Evidence (t.mjs): gray-matter's `---js` fence EVALUATES JavaScript: a sample `{ x: process.exit(7) }` terminated the trial process with exit 7. Untrusted input must never reach it (can be disabled with custom `engines`, but the default is unsafe, and its js-yaml 3 has advisories and is unmaintained).
Alias bomb (9 levels x 9 refs): `yaml` rejects with "Excessive alias count indicates a resource exhaustion attack" in 2 ms at the default `maxAliasCount` (100); we pass it explicitly. js-yaml 3 parsed it "successfully" (lazy references; blows up on stringify/iteration, so a metadata table walking values would explode). `!!js/function` tags: `yaml` emits a warning and keeps the raw string; no execution.
Integration: split on a regex `^---\r?\n([\s\S]*?)\r?\n---` (also strip BOM), `YAML.parse(block, { maxAliasCount: 100, schema: 'core' })` in try/catch, treat result as table only if a plain object; cap block size (e.g. 64KB) and render values with a depth/length cap (stringify nested via `YAML.stringify`). Runs in renderer (pure JS, ESM+CJS, ~1.3MB unpacked but tree-shakes; `yaml/browser` is fine for Vite) or main (preferred: parse in main on file read, ship plain JSON over IPC, keeps the 100KB+ bundle out of the renderer). In the markdown preview add `remark-frontmatter` (5.0.0) only to hide the block from react-markdown output.

## 3. Open in editor / terminal / file manager
launch-editor 2.14.2 (MIT, modified 2026-10-06, deps picocolors + shell-quote). Read of the source: on win32 it builds a string and runs `childProcess.exec(cmd, { shell: true })` through cmd.exe. Safety rests on sanitisation: `^`-escaping `& | < > , ; = ^`, rejecting `\r\n` and `%` in args, rejecting UNC paths. That is the post-CVE hardening (earlier versions were injectable via filenames like `& curl ...`), and 2.14.2 is the current line, but it is still a shell on Windows. Other problems for us: it guesses the editor by scanning running processes (a desktop app wants an explicit user choice), needs the editor on PATH (Node 24 cannot spawn `.cmd` without a shell, CVE-2024-27980 hardening, so even code.cmd forces the shell), reports errors via callbacks only. Line numbers: yes, for VS Code (`file:line:col`) and Cursor via same table entry (code/cursor mapped as VS Code family; Cursor listed in editor-info). `open-editor` 6.0.0 (ESM, execa 9 + open 11 + env-editor, ~10 deps) is the same idea with more weight; `open` 11.0.4 (MIT, 6 deps, powershell-utils) opens with default app; it spawns PowerShell on Windows, so for files/folders `shell.openPath` is strictly better.
Recommendation: do NOT depend on any of them. This is 20 lines and the allowlist is the security boundary:
- Folder in file manager: `shell.openPath(dir)`; reveal file: `shell.showItemInFolder(file)`; default app: `shell.openPath(file)` (returns error string, check it; refuse `.exe/.bat/.cmd/.ps1/.lnk` etc. via extension denylist, or require confirm).
- Editor: resolve known executables, not PATH: `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe`, `%LOCALAPPDATA%\Programs\cursor\Cursor.exe` (also `%ProgramFiles%\...` variants), `execFile(exe, ['--goto', `${file}:${line}:${col}`])` (or just `[dir]`), `{ windowsHide: true, shell: false }`. Real `.exe` means no cmd.exe, no escaping needed; reject paths that are not under a registered project root and strip nothing else (execFile passes argv verbatim; a leading `-` path is neutralised by always passing an absolute path, or `--` where supported).
- Terminal: no package does this safely (`open` just launches default). Use fixed `execFile('wt.exe', ['-d', dir])` (wt.exe is an App Execution Alias in `%LOCALAPPDATA%\Microsoft\WindowsApps`; spawn it by absolute path; works with shell:false). Fallback `execFile('powershell.exe', ['-NoExit'], { cwd: dir })` is NOT silent-detached; prefer `cmd.exe /c start` is a shell, avoid. Do `dir` validation: must exist and be a directory (`fs.stat`), absolute.
Detection on THIS machine (via cmd.exe `where`, read-only): FOUND `code` (C:\Users\Arda\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd; Code.exe verified present one level up), `cursor` (C:\Users\Arda\AppData\Local\Programs\cursor\resources\app\bin\cursor.cmd; Cursor.exe verified present), `wt` (verified at ...\Microsoft\WindowsApps\wt.exe; `where` did not list it only because cmd ran from a UNC cwd/PATH quirk, the file exists), `explorer.exe`. NOT found: windsurf, notepad++, pwsh (7), subl. Git Bash exists at C:\Program Files\Git\bin\bash.exe.
Detection shape: `fs.access` on the candidate absolute paths at panel open (cheap), expose only found ones in the menu.

## 4. Tree component
| pkg | version | modified | peers | deps | notes |
|---|---|---|---|---|---|
| @headless-tree/core + react | 1.7.0 | 2026-05-17 | react `*`, react-dom `*` | 0 (core 768KB unpacked, react 136KB) | headless, roles `tree`/`treeitem`, features: asyncDataLoader (lazy children), hotkeysCore, selection, search/typeahead, renaming, expandAll, dnd; ESM+CJS |
| react-arborist | 3.16.0 | 2026-07-25 | react >=16.14 | react-dnd x2, react-window, redux 5, use-sync-external-store | virtualized (react-window), own markup/styles, DnD mandatory weight, ARIA less complete |
| react-complex-tree | 2.6.4 | 2026-08-24 | react >=16 | 0 (1.3MB unpacked) | accessible (WAI-ARIA, a11y-focused), no virtualization |
Pick headless-tree: unstyled (works with our CSS and Base UI tokens), WAI-ARIA keyboard model built in (arrows, Home/End, typeahead, `*`), `asyncDataLoaderFeature` matches lazy `listDir` IPC, no peer constraints for React 19. Gap: no built-in virtualization. It exposes flat `tree.getItems()` (visible rows in order) and `scrollToItem`, so pair it with a virtualizer for big folders: `@tanstack/react-virtual` (already common) over `getItems()`, with fixed row height and `aria-setsize/posinset/level` from `item.getItemMeta()`. Because we only load expanded folders, lists stay small except a single huge folder, which virtualization covers.
Risk: young API (1.x, one maintainer, publishes frequent prereleases `0.0.0-<date>`; pin the exact version). React 19: no peer bound, ref/props model fine; verify in a spike before committing. Fallback if virtualization is too fiddly: react-arborist (accept react-dnd bundle).

## 5. Fuzzy filter (50k synthetic paths, Node 24 on this box; t.mjs/f.mjs)
| pkg | version | modified | size | license | prepare | query | highlight |
|---|---|---|---|---|---|---|---|
| fuzzysort | 4.0.2 | 2026-08-13 | 79KB unpacked, 0 deps | MIT | 39-48ms | 0.7-27ms (limit 50), unprepared 37ms | `indexes` + `fuzzysort.highlight` |
| @leeoniya/ufuzzy | 1.0.19 | 2025-08 | 135KB | MIT | none | 3-6ms | ranges via `uf.info` (more setup) |
| fzf | 0.5.2 | 2023-04 | 71KB | BSD-3 | 25ms | 33-64ms | `positions` set |
| fuse.js | 7.5.0 | 2026-08 | 417KB | Apache-2 | 6ms | 106ms | `includeMatches` |
Pick fuzzysort: fast enough, best path semantics (prefers filename/consecutive matches), simple highlight indexes, actively maintained, ESM. uFuzzy is faster per keystroke but its ranking and API are more configurable than we need; reserve as an alternative. fzf unmaintained since 2023; fuse.js slowest and heavier.
Integration: main process (or a worker) holds `fuzzysort.prepare(relPath)` array for the cached file index of a project; renderer sends the query, receives top 50 `{path, indexes}`; or keep it in the renderer if the index is shipped once. Debounce nothing at 50k (<30ms). Note: "Filter files..." over a *lazy* tree only sees loaded dirs; quick-open needs a separate index (git ls-files via execFile, or one gitignore-aware walk in background after open) , design decision for the owner.

## 6. View source with @pierre/diffs
Yes, no new dependency. `@pierre/diffs/react` exports `File` (props: `file: FileContents { name, contents, lang?, cacheKey? }`, `options: FileOptions` including `disableFileHeader`, `selectedLines`, `renderHeaderMetadata`, `lineAnnotations`, `contentEditable?: boolean` off by default, `disableWorkerPool`, `prerenderedHTML`). Language is inferred from `name`. Shiki highlighting is built in. For big files use `VirtualizedFile` (components dir) or `CodeView` (controlled `items`, virtualized scroll, `scrollTo`, line selection, optional editor via `createEditor`; `onScroll`). Recommendation: `File` for typical source view; switch to `CodeView` with one item for files over a threshold (~5k lines) since it virtualizes. Theme: reuse the options already used in `packages/desktop/src/renderer/changes-panel.tsx`. Caveat: package is a beta (1.3.0-beta.10), already pinned by us.

## Open risks / things not verified
- headless-tree + virtualizer under React 19 not spiked in a browser; only installed and type/feature inspected.
- launch-editor advisory list was assessed from source and `npm audit` (clean); GitHub advisory text for earlier Windows injection fixes not fetched. Not needed since we do not use it.
- `ignore` handling of `core.excludesFile` and `.git/info/exclude` is ours to add.
