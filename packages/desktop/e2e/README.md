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

Run the files **one at a time**: `pnpm --filter @namzu/desktop test:e2e` is `xvfb-run -a node --test
--test-concurrency=1 "e2e/*.test.mjs"`. `node --test` runs files in parallel by default, and several real Electron windows on
one Xvfb display steal focus and keyboard input from each other: that is the likely cause of the "element detached" and hover-card
timeouts seen in a 32-process run (the same files pass one by one; five files in parallel on a quiet machine did
not reproduce it, so the cause is removed rather than observed). The harness backs this up: it takes a lock
for the display (`display-lock.mjs`, a directory under the temp folder holding the owner's process id, taken over
when that process is gone) before it launches anything, so a parallel run queues instead of flaking.
`NAMZU_E2E_NO_LOCK=1` turns the lock off, for a run with one display per file. Do not raise a timeout to cover a
parallel flake; wait for the state the test needs instead.

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

## Providers and error wording

`ux-providers-errors.test.mjs` runs a first-timer with no key (the harness drops the key variable and, under WSL, the
variables that let the CLI read the paired Windows account's sign-ins): the composer's empty state, Settings ▸ Models
(paste, check, remove, nothing left in the window or on disk afterwards), the wording of a 502, a 401 and a 429 countdown
(`fake-model.mjs` answers a rule step `{ status, body, headers }` as an HTTP failure), a deleted folder, a killed host
that reconnects by itself, an engine stand-in that cannot start, and an approval card that replaces a file. Pictures go to
`research/ux-20261009/providers-errors/` in both themes.

## Pals

`ux-pals.test.mjs` is one flow through the Pal screens in plain words: the welcome page (one Customize action, a
hint for an empty name), creating a Pal (no leftover empty conversation tab, a Pals heading), the computer notice
without build instructions and the status that stays a status, Pause and Resume with the reason in the composer, a
message approved from a conversation (the card's wording, the visible "Sent to" line, the Messages list with its text,
time and status), the settings sections, a duplicate name, the compact 900px bar and the Delete wording. Pictures go
to `research/ux-20261009/pals/`.

## Creating a Pal

`pals-create.test.mjs` patches the frozen copy so `openPal` waits on a gate the flow holds and releases from the main
process (and can fail once on demand), so nothing waits on the clock. It covers a double click on Save making one Pal, a
second create of the same name in any case refused with a suggestion, Customize and New Pal staying usable and starting
empty while the new Pal opens, Cancel, and a failed start leaving the Pal with Retry. Pictures go to
`research/pals-create-20261009/` (the Windows run, on a fresh unpacked build with a temp profile, is in `windows/`).

## Starting a Pal from a conversation

`ux-pal-start.test.mjs` sends an approved message to an idle Pal and follows the question under it: Start, the run on
the Pal's own computer, and the Pal's own tab; a second flow on a machine with no container engine checks **Not now**,
the waiting line on the Pal's page, the plain "computer is not available" answer and **Retry**. The success flow sets
`NAMZU_E2E_PAL_COMPUTER=fake`, which `cli-entry.mjs` answers with `fake-pal-computer-hooks.mjs`: `@namzu/sandbox` keeps
every export but its computer provider, whose guest is a recorder, so the real host and the real dispatch read the
message with no Docker. Pictures go to `research/pal-wake-20261009/`.
