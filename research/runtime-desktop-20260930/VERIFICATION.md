# Verification — native operator foundation

## Actual execution

- Native Electron 44.5.1, Linux/WSL2, Node 24.19.0, pnpm 10.33.0.
- Playwright drives the real desktop, CLI ACP process and SDK query loop. Only
  model I/O is scripted. Actual foreground/background commands ran in a private
  temporary project, and a running background process was stopped through the UI.
- The selected model reached the provider request; queued input started in a new
  turn; separate tool batches needed separate approvals. Reload preserved the
  pending approval and queue. Full app restart loaded durable history from the
  CLI logs. IME and Shift+Enter do not submit. The 600×540 layout has no horizontal
  overflow; wide/narrow captures are in `artifacts/`.
- A normal `pnpm --filter @namzu/desktop start` launch also rendered the real
  welcome window. Its renderer process carried `--enable-sandbox` without a
  `--no-sandbox` flag. Playwright's launch uses its own test flags, so its Node
  isolation assertions alone are not a proof of OS sandboxing.
- A separate actual anonymous Zen CLI turn returned `NAMZU_LIVE_ZEN_OK`, ending
  normally with no error. This verifies the current `space-bunny-free` route;
  it does not assert availability of all models or providers.

## Repository checks

`artifacts/local-gates.json` records 48 successful local commands: the complete
repository gate set, including workspace lint/typecheck/build/test, SDK process
regressions, coverage floors and test presence, evals, workflow parity, external
names, log rules, metadata/export checks, installer parsing, docs conformance and
compiled fences, the tarball consumer installation, and publint for all 21
publishable packages. The enumerator uses the workspace, including nested
provider packages. The consumer check restored its temporary version snapshot.

The workspace suite passed 9,586 SDK tests and 4,665 CLI tests (5 existing CLI
skips), plus all sibling package suites. Desktop transport/projection/ownership
has 13 tests covering transport, ownership, reconnect, safe formatted messages
and current-turn activity. Following the final metadata projection and composer changes, focused CLI tests, desktop tests and whole-root
lint/typecheck/build were rechecked. Native flow was checked against the final UI.

## Interface revision

The initial 48-gate receipt above belongs to the committed foundation at
`9ef65063`. The renderer was revised after the operator's design review. Its
native flow was rerun with actual imported UI primitives, the CLI wordmark and
phosphor palette, keyboard menus, appearance persistence, wide/narrow captures
and deterministic panel-motion/reduced-motion checks. `UI-AUDIT.md` and the
updated `artifacts/native-receipt.json` record that evidence.

A workspace rerun found 12 CLI failures while a foreign `.git` marker appeared
in the shared `/tmp` ancestor. Project-root discovery consequently grouped
otherwise separate fixtures. The marker was not removed or ignored, and no
production scope check was changed. Rerunning under a private `TMPDIR` outside
any checkout passed all 510 CLI files: 4,665 tests, 5 existing skips. The temporary
IPC diagnostic edit was restored. The final revision gate run is recorded
separately; an earlier green receipt is not presented as proof of a newer tree.
The first independent temporary root was too long for the peer socket fixtures
and had a hidden ancestor that one file-walk assertion treats as hidden content.
Those 8 SDK assertions failed explicitly. A short, non-hidden `/var/tmp` root
satisfies the existing socket and file-walk fixture assumptions; the two affected
files pass there. Neither SDK production code nor assertions were changed.

The final revision's 48 successful commands are in
`artifacts/revision-gates.json`. Its earlier stopped `dash` result is retained;
`NAMZU_DASH` supplied the previously installed executable and the runner resumed
that stage and every later stage. Coverage floors, tarball consumer installation,
docs, signature types and publint for all 21 publishable packages passed. The
consumer's temporary manifests, lockfile and all changesets were restored.
Following the final activity refinement, whole-root typecheck/lint and desktop
build/13 tests/native flow were explicitly refreshed. No remote CI or release is
implied by these local receipts.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm -r build
xvfb-run -a -s '-screen 0 1600x1000x24' pnpm --filter @namzu/desktop test:native
node research/runtime-desktop-20260930/validate.mjs "$PWD"
```

`dash` must be installed or supplied as an executable path in `NAMZU_DASH`.
Set `NAMZU_VALIDATION_FROM` to an exact stage name to continue a stopped run in a
separate log directory. Earlier receipts retain the steps already executed.
The validation runner writes per-command logs and actual exit codes to a private
system temporary directory; it stops at the first failing command. An optional
`live-zen.mjs` probe calls the public free endpoint and is deliberately excluded
from hermetic CI.

## Material limits

Windows/macOS native execution, installers, signing and auto-update were not
validated here. This is a private source-built preview. Attachments, embedded browsing and
terminal emulation are separate future slices.
Drafts/queues survive window navigation/reload while the main process remains;
they are not a crash-durable database. The app closes its owned runtime on exit.
No existing live user jobs were changed. No remote push, PR merge or package
publication was performed for this foundation.

The short-root rerun passed every SDK assertion and found one CLI presentation
assertion expecting `(suggested)` on a single row. The real skill-save screen
retained every character but correctly wrapped the label after a long path. The
check now joins rendered rows, as the adjacent built-in destination check
already does. The complete five-case real tool/overlay fixture passes. This is a
verification correction; the production skill-save renderer is unchanged.

A final motion review also separated current-turn active tool IDs from retained
interrupted tool history. Old pending rows remain visible without shining or
being described as current work in a later turn. The regression covers stop,
next turn, completion and abort. Captures explicitly await finite animations.
