# Changes review view, 2026-10-07

Proof for the Changes tab review view against the reference (the Codex Changes tab: scope pill with totals,
one file's diff on the left, filterable file tree with per-file counts on the right). Layout and density follow
the reference; wording is ours.

Re-run with the desktop dev server up: `node research/changes-review-20261007/capture.mjs` (it prints PASS/FAIL checks and rewrites `artifacts/`).

- `00` stacked layout at the default panel width (tree folds above the diff), `01` two columns at 900 px.
- `03` This conversation (a file edited twice is one row), `04` Uncommitted changes with added, untracked, renamed, deleted and binary files.
- `04b` Open file on an uncommitted file (design.md) adds a tab that reads it directly.
- `05` `]` moved to the next file, `06` filter, `07` binary message.
- `08`-`10` light theme at 900x720: stacked, files open, and the 640 px two-column threshold.

Known gap: the preview has no clipboard, so Copy path and Copy diff are not exercised there.

Checks the capture asserts (PASS/FAIL on stdout): a card file row opens Last reply with the whole reply and that file selected
(`aria-selected` on exactly one tree row), the binary header has no `+0 −0`, Open file on an uncommitted path adds its tab,
`]` steps files, the filter narrows the tree, no horizontal scroll at 900 px.

Compare against the reference `images/12.png`: scope pill plus totals at top left, toolbar at right, one diff left, filterable tree right.
Rerun: start the dev server, then `node research/changes-review-20261007/capture.mjs` from the repo root.
