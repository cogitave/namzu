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
has 10 tests after adding reconnect coverage. Following the final metadata
projection and composer changes, focused CLI tests, desktop tests and whole-root
lint/typecheck/build were rechecked. Native flow was checked against the final UI.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm -r build
xvfb-run -a -s '-screen 0 1600x1000x24' pnpm --filter @namzu/desktop test:native
node research/runtime-desktop-20260930/validate.mjs "$PWD"
```

`dash` must be installed or supplied as an executable path in `NAMZU_DASH`.
The validation runner writes per-command logs and actual exit codes to a private
system temporary directory; it stops at the first failing command. An optional
`live-zen.mjs` probe calls the public free endpoint and is deliberately excluded
from hermetic CI.

## Material limits

Windows/macOS native execution, installers, signing and auto-update were not
validated here. This is a private source-built preview. Rich Markdown,
attachments, embedded browsing and terminal emulation are separate future slices.
Drafts/queues survive window navigation/reload while the main process remains;
they are not a crash-durable database. The app closes its owned runtime on exit.
No existing live user jobs were changed. No remote push, PR merge or package
publication was performed for this foundation.
