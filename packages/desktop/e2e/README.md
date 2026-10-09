# Namzu Desktop end-to-end flows

Real Electron, real CLI host, scripted model. No paid model call, no network, no
owner data.

## Run

```bash
pnpm --filter @namzu/desktop build        # the harness runs the built dist/
export PATH=$(echo "$PATH" | tr ':' '\n' | grep -v '^/mnt/' | paste -sd:)   # WSL: keep /mnt out of PATH
cd packages/desktop
xvfb-run -a node --test e2e/flows.test.mjs
# one flow:
xvfb-run -a node --test --test-name-pattern="archive" e2e/flows.test.mjs
```

Display: on WSL and Linux CI the run uses `xvfb-run` (Electron needs a display).
It was run in WSL under Xvfb, not on the Windows side.

## What it does

- `harness.mjs` freezes `dist/` into a temp app directory (a rebuild during a run
  cannot pull files out from under it), points `--user-data-dir`, `NAMZU_HOME`,
  `HOME` and `USERPROFILE` at temp directories, strips credential variables, and
  stubs the native folder and message dialogs from the test.
- `cli-entry.mjs` is the `NAMZU_DESKTOP_CLI` entry: it patches `fetch` (see
  `redirect-fetch.cjs`) so the chat-completions driver talks to the scripted server, then
  loads the real `packages/cli/dist/bin.js`. Any other outbound host is refused.
  Electron strips `NODE_OPTIONS`, so a `--require` preload is not an option.
- `fake-model.mjs` serves `/v1/chat/completions` (stream and not) and `/v1/models`.
  A rule matches the newest user message it claims; its steps are consumed by the
  number of tool results already in the request, so a replay depends only on the
  request, never on timing. `hold`/`release` park a reply for stop/queue flows.
- Tests never race wall-clock time: they await the UI state through Playwright's
  auto-waiting `expect`, and the per-test timeout catches a real hang.
- On failure the temp directory is kept and its path printed; `shots/failure.png`
  inside it is the screenshot.

Not run by CI yet: it needs a built workspace and a display.

## Terminal tabs

`terminals.test.mjs` covers terminal tabs on Linux (plain shell, size, tab switch, whole-tree kill on close, the
Desktop | CLI switch, an installed engine's flags through stand-in programs on `PATH`, the status badge, restart
as an ended session) and writes dark and light screenshots to `research/terminal-20261008/`.
`windows-smoke.mjs` is the same checks on Windows, run by hand with Windows `node` from a folder holding a staged
app (`scripts/stage-installer.mjs`), Electron's Windows build, `@playwright/test` and this folder's `fake-model.mjs`,
`redirect-fetch.cjs` and a `cli-entry.mjs` pointing at the staged CLI. It uses a temp profile under a path with a space.

## Model popup header

`model-header.test.mjs` opens the model popup on the Namzu engine (wordmark chip) and on Codex, in both themes at window widths 900, 1100, 1280 and 1440 and 100, 125 and 150% zoom, and measures every header part with `getBoundingClientRect`: none may overlap or leave the header, and the chip, switch and search button are never squeezed. Pictures go to `research/model-header-20261009/`.

## External engines

`engines.test.mjs` puts a stand-in `codex` on `PATH` that speaks the app-server protocol and records every process it is
started as. It covers choosing Codex while the engine is held in its first start (the model trigger reads "Starting Codex…"
and the choice has not waited), one process serving the picker, the list and the first message (one start, one
`initialize`), and no process outliving the app. Pictures go to `research/engines-20261009/`.

## Engine updates

The second half of `engines.test.mjs` serves a stand-in npm registry on loopback (`NAMZU_ENGINE_REGISTRY`, with
`NAMZU_ENGINE_FIRST_CHECK_MS` shortening the first check) and puts old stand-ins first on `PATH`: a `codex` that is a
link into a `node_modules/@openai/codex` folder (an npm global install), an `npm` that really rewrites it to the
registry's version and swaps in a longer model list, and a second engine under `~/.local/bin` whose `update` does
the same. The flows cover a registry that is down (quiet), the badge, the toast and the engine popup note once it
answers, Update running in a visible terminal tab and Namzu's own idle server for the engine ending first, the version
re-read and the model list refreshed, an update refused while the engine is open in a terminal, a failed command and
Try again, the second engine's own command, and an install Namzu cannot name (the command and Copy, nothing run). Every other
flow's harness points `NAMZU_ENGINE_REGISTRY` at a dead port, so no run reaches the real registry.
