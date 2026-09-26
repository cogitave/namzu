# Changelog

## 2.0.2

### Patch Changes

- 567ada8: Updated package examples and evaluation fixtures for the SDK's `ToolRegistry`
  removal. Browser, computer-use and LSP documentation now show toolsets; the
  evals use `toolsets` when they call the kernel. Provider changes are test
  fixture migrations only, with no provider runtime API change. Consumers that
  pass tools to the SDK should use `toolsets: readonly Toolset[]` and wrap their
  definitions with `toolset(source, definitions)`.

## 2.0.1

### Patch Changes

- 2d4ff9a: Earlier entries in this package's CHANGELOG no longer name one particular application built on namzu, or quote a path from outside this repository. This changes only the CHANGELOG.md that ships in the tarball; no code or types change, and there is nothing to do to upgrade.

## 2.0.0

### Major Changes

- 82769f1: On Windows and under WSL, `SubprocessComputerUseHost` now drives the desktop through cua-driver (MIT, github.com/trycua/cua) instead of starting `powershell.exe` for every action, and every adapter now takes and returns physical pixels. Both are changes a caller can see; read on before upgrading.

  **What changes by default on Windows / WSL.** The first `initialize()` downloads cua-driver 0.28.2 for the machine's architecture (a 27–29 MB archive from the project's GitHub releases), checks the SHA-256 of the archive and of `cua-driver.exe` against values pinned in this package, and keeps only the executable in `<NAMZU_HOME>/computer-use/cua-driver/0.28.2/` (`~/.namzu` unless `NAMZU_HOME` is set). One `cua-driver.exe` process then runs until `host.dispose()`; call `dispose()` when you are done. It runs with its telemetry and release check off and without environment variables whose names look like secrets. If it cannot be downloaded, verified or started, the host falls back to PowerShell and says why in `host.fallbackReason`.

  To keep the old behaviour — no download, no long-lived process — set `NAMZU_CUA_DRIVER=off` or pass `new SubprocessComputerUseHost({ windows: { backend: 'powershell' } })`. To use a cua-driver you installed yourself, set `NAMZU_CUA_DRIVER=<path to cua-driver.exe>` or `windows: { cuaDriverPath }`. `windows: { download: false }` uses only a cached or configured build.

  **Physical pixels everywhere.** Points you pass to `execute()` and sizes you get back are pixels of the captured bitmap, as the SDK's host contract now states. This changes results only on scaled displays:

  - macOS Retina: `getDisplayGeometry()` returns the capture's resolution (2880x1800, not 1440x900; 3360x2100 in a "Looks like 1680x1050" mode), `cursor_position` is in pixels, and click/move/drag points are pixels; the adapter divides by the capture's pixels per point for `cliclick` and System Events, once. Before, a click aimed at the middle of a Retina screenshot landed near the bottom-right corner. Screenshots show the main display only, the one the input tools address. If you converted screenshot pixels to points yourself, stop.
  - Windows above 100 % scaling: both backends are DPI aware, so the capture is the whole display (it was the top-left part) and points are physical (they were DPI-virtualised).
  - Every capture now carries `result.display` (`id`, origin, size, `scaleFactor`).

  **Also new.** With the cua-driver backend, `capabilities.windows` is `true` and `host.listWindows()` / `host.focusWindow(id)` work (focus restores a minimised window and reports what is actually in front); `host.captureRegion()` exists and throws where the adapter has no region capture. `host.backend` names the backend in use. Measured on a 3440x1440 display: a click went from 0.68–0.83 s to 0.13 s, a screenshot from 0.40 s to 0.08–0.13 s.

  **Smaller differences on the cua-driver backend.** `capabilities.clipboard` is `false` (no clipboard action was ever offered); `win`/`super` in a key chord press the Windows key (PowerShell's SendKeys pressed Ctrl); a single punctuation key such as `/` is typed as text so the keyboard layout cannot change it. Only the primary display is captured, as before. The PowerShell fallback now types text through Unicode key events instead of SendKeys, so `+ ^ % ~ ( ) { }` and non-Latin text arrive as written.

### Minor Changes

- 82769f1: `computer_use` can read a window's controls and act on them by reference, on a host that declares `uiTree` — which the Windows backend of `@namzu/computer-use` now does.

  **What changes for a caller of the tool**

  - Two new actions when the host declares `uiTree` and implements `uiSnapshot` and `uiAct`: `ui_snapshot { window_id? }` returns the window's accessibility tree as text, each control that can be acted on with a ref such as `e12`; `ui_act { ref, action, value? }` performs `invoke`, `set_value`, `toggle`, `select`, `expand`, `collapse`, `focus` or `scroll_into_view` on it and returns a screenshot afterwards. `ui_act` may be in a batch; `ui_snapshot` may not. Refs count up across snapshots and only the latest snapshot's are accepted, so a stale ref is refused rather than acting on another control. `ActionInput` gains both, so code that switches exhaustively over `input.type` needs two more cases — that is why this is a major release for `@namzu/sdk`.
  - `ui_snapshot` is read-only; `ui_act` is destructive.
  - `list_windows` now returns its window lines inside an untrusted-content frame (`<namzu-untrusted kind="desktop-windows">`), since titles are whatever each application shows. The lines themselves are unchanged; code that parsed the whole output text needs to skip the frame's three header lines.
  - `createComputerUseTool` returns a `ComputerUseTool`, a `ToolDefinition<ActionInput>` with `describeUiRef(ref)` (experimental), which names the control a ref points at for a review screen.
  - `UiSnapshot` gains optional `title` and `app`; `UiElement.ref` is empty for an element nothing can be done with. Both types stay experimental.

  **`@namzu/computer-use`**

  On Windows and WSL with the cua-driver backend, `capabilities.uiTree` is `true` and `SubprocessComputerUseHost` offers `uiSnapshot(windowId?)` and `uiAct(ref, action, value?)`, read from cua-driver's UI Automation walk. A control is invoked in the background, without moving the pointer or bringing its window to the front; a field without a settable value is typed into when it is empty. An action whose driver died mid-request comes back as not done with an unknown outcome, never retried. The PowerShell fallback and the other platforms do not declare `uiTree`, so nothing changes there.

## 1.4.3

### Patch Changes

- 8d5223b: Nothing a consumer installs or calls changes, and that is the whole of this
  release. `vitest` moves from `^3.2.6` to `^4.1.11` in the `devDependencies` of
  all nineteen packages that declared it, and `@vitest/coverage-v8` moves with it
  in `@namzu/sdk`. Every occurrence is a devDependency — checked, not assumed —
  so `dependencies`, `peerDependencies`, exports, types, defaults and the wire
  shape are untouched, and the published tarballs differ from the previous
  release only in `package.json#devDependencies`.

  The reason is a security fix with no 3.x backport. `GHSA-82fw-gwwq-j7x9`
  ("Path Traversal / Arbitrary File Read via `@vitest/mocker` Redirect Mock")
  covers `vitest` and `@vitest/mocker` from `2.1.0` up to `4.1.11`, so `^3.2.6`
  can only be resolved by leaving the 3.x line. `4.1.11` is the first patched
  release and is what the lockfile now resolves for both.

  What this costs anyone who works on the repository rather than with it: the
  upgrade was not a version bump. Vitest 4 changed test discovery, coverage
  configuration, mock construction and reporter output, and each of those broke
  something here that had to be migrated rather than worked around. Those fixes
  are all under `__tests__/`, `vitest.config.ts` files and `scripts/`, none of
  which is published, which is why this is a patch and not a major.

  You do not need to do anything. If you pin `vitest` yourself to run this
  project's own suites, note that the config files it ships are now written for
  `>= 4.1.11` and will not run under 3.x.

## 1.4.2

### Patch Changes

- b4408d6: Add optional exact desktop `supportedActions`, `mouseClickButtons` and
  `mouseDragButtons` capabilities. The computer-use tool uses them in its model
  schema and rejects unsupported operations before contacting the desktop.
  Custom hosts that omit these fields retain broad-flag behavior.

  Native adapters now publish supported actions. On macOS, unavailable scroll,
  move and drag actions are no longer advertised as usable. Middle clicks and
  non-left drags fail explicitly instead of accidentally performing a triple
  click or a left drag. Left/right click support depends on cliclick availability.

## 1.4.1

### Patch Changes

- ec1ac3c: `SubprocessComputerUseHost.initialize()` asks the desktop one cheap question (its geometry) after loading the adapter and refuses to become ready if it does not answer. Finding PowerShell on a WSL PATH is not the same as having an interactive Windows session to capture; the host used to report ready and let every screenshot fail the same way. The error names the adapter and what the desktop said, and a host that only ships the tool when `initialize()` succeeds now leaves it unmounted.

## 1.4.0

### Minor Changes

- 354b7a1: Ship and mount desktop computer use in the interactive CLI when its adapter
  initializes, with the host lifetime owned by the agent session and no exposure
  on unattended surfaces. WSL now targets the paired Windows desktop through
  `powershell.exe` instead of misclassifying WSLg as a Linux compositor session.
- 5854b4d: Expose a stable computer-use unknown-outcome contract and preserve it in tool results. A host can now report that a desktop action started without proving its final state, and models receive explicit unsafe-to-retry guidance plus structured action, timeout, and exit evidence.

  Classify subprocess failures after click, drag, scroll, text-entry, and key actions as unknown outcomes. Consumers can catch `ComputerUseOutcomeUnknownError`; ordinary read failures, idempotent pointer moves, and process-start failures keep their existing error behavior.

## 1.3.0

### Minor Changes

- bb8cb05: Export the 45 types that exported signatures already named.

  Each is the parameter or the result of a function that was already public, and none of them was reachable. A consumer could call `createLogger` and had no name for its options or its return; could call `compactRegion`, `runBidi`, the handoff helpers, the replay helpers, and had to inline every shape or reach for `any`. The package's vocabulary stopped at the function name.

  Additive: the original 28 function-signature types plus constructor contracts including `AgentManagerDeps`, `TopicManagerDeps`, `ProjectManagerDeps`, `DiskTopicStateStoreConfig`, `DiskMessageFeedbackStoreConfig`, `MessageExistenceCheck`, `EnvCredentialProviderOptions`, `FileLockManagerConfig`, `GitWorktreeDriverConfig`, `CapacityDimension`, `HandoffLockRejectedReason`, `SessionSummaryMaterializerDeps`, `ArchivalManagerDeps`, `ArchiveBackendRef`, `DiskArchiveBackendConfig`, `SlidingWindowManagerConfig`, and `SubprocessComputerUseHostOptions`.

  Nothing changes for existing code.

  A CI step keeps it that way. `check-signature-types-exported.mjs` resolves exported function signatures and public class constructors, then fails when a type they name is declared in the package and not exported. The constructor branch has its own self-check so removing it cannot turn the gate silently green.

## 1.2.0

### Minor Changes

- 03e363c: Declare the Node floor these packages already had, and export a type `TelemetryConfig` already required.

  **`engines.node: ">=20.0.0"`.** Only `@namzu/cli` declared one; the other fourteen published without any, so npm could not warn a consumer installing onto an unsupported runtime — they got a crash at some later import instead. The floor is not new: `@namzu/cli` has declared it since it shipped and `install.sh` has enforced it since it existed. This makes the other fourteen say the same thing.

  If you install with `engine-strict=true` on Node 18, an install that previously emitted nothing will now fail. Upgrade to Node 20 or newer, which the code already assumed. Everyone else sees no change, or an `EBADENGINE` warning that replaces a later crash.

  Worth stating plainly: CI verifies Node 22 and 24. The 20 floor is a declared minimum, not a tested one.

  **`SpanProcessorLike` is now exported from `@namzu/telemetry`.** `TelemetryConfig.spanProcessors` takes `readonly SpanProcessorLike[]`, and the type had no export — a field on the public surface whose type was not on it, so a host supplying the value had to inline the shape or reach for `any`.

## 1.1.1

### Patch Changes

- b2c005c: Make each README an npm package page rather than the package's manual.

  `@namzu/sdk`'s README was a twenty-four-section architecture tour, 45 KB of it; the others ran to several hundred lines each. That is the right shape for a single-package repository, where the README _is_ the documentation, and the wrong one here — it duplicated a `docs/` tree that already existed, and nothing checked that the two agreed.

  Each README is now what a reader needs in the first minute: what the package is, install with its Node requirement, one working example, and links. The long-form material moved into `docs/` whole — `docs/sdk/architecture.md`, `docs/cli/reference.md`, `docs/packages/<name>.md` — where the doc gates cover it.

  Two documentation defects fell out of the move, both in `@namzu/telemetry`'s session-export example, and both had been shipping: the config field is `redactors` and takes a list, not `redactor` taking one; and `secretRedactor` is a factory that has to be called. The required `destination` field was missing from the example entirely. They surfaced because a README is gated by nothing and `docs/` is compiled against the built SDK.

  No API change.

## 1.1.0

### Minor Changes

- b26951b: The three errors this package throws are now exported.

  `AdapterUnavailableError`, `ActionCapabilityError` and `SpawnError` have been
  thrown since the first release and none of them was importable, so the only way
  to tell "the binary is not installed" from "the command ran and failed" was to
  match on `err.message` — a sentence this package is free to reword. The README
  documented them as an error surface the whole time.

  `AdapterUnavailableError.missing` carries the list of binaries to install, which
  is the actionable half and was unreachable without the type. `SpawnError.result`
  carries the exit code and stderr.

  `SpawnOptions` and `SpawnResult` are exported as types alongside them.

## 1.0.2

### Patch Changes

- 48d9d67: Published tarballs no longer contain test files.

  `files: ["dist", "src", ...]` reads as "the build output and the sources" and
  means "everything the compiler emitted and everything in the tree", so every
  compiled test, its declaration, and both source maps shipped to the registry —
  and for the twelve packages that also ship `src`, the raw test sources went with
  them.

  Measured on the versions currently published:

  | package      | files       | of which tests | unpacked           |
  | ------------ | ----------- | -------------- | ------------------ |
  | `@namzu/sdk` | 3879 → 2239 | 1640 (42%)     | 12.73 MB → 6.81 MB |
  | `@namzu/cli` | 462 → 282   | 180 (39%)      | 1.21 MB → 0.73 MB  |

  Nothing you can import changes. Every package restricts `exports` to `"."`, so
  Node refused a deep subpath into those files already — they were weight in the
  tarball and nothing else. Hence `patch`: there is no consumer-visible surface
  here, only less to download.

  The exclusions are at the packaging layer, not the compiler. Adding `exclude`
  to `tsconfig.json` would have kept tests out of `dist` and also dropped them
  from `tsc --noEmit`, silently ending type-checking of the entire test suite —
  trading a packaging defect for a much worse one.

## 1.0.1

### Patch Changes

- ee1aa38: Remove references that pointed readers at a directory they can never open.

  Agent working memory in this repository is gitignored, and several published
  artifacts cited paths inside it. None of them resolved for anyone but the
  maintainer, and four cited session folders that no longer exist at all.

  What a consumer sees change:

  - `@namzu/sandbox` raised `Sandbox backend 'x' is not implemented yet. Track
progress in <a local notes directory>/...` — a runtime error
    instructing the reader to open a path that is not in the package, not in the
    repository, and not on the internet. It now names what does ship instead.
  - `@namzu/computer-use`'s README linked to an adapter-pattern document under a
    directory that does not exist in any checkout. It now links to the two
    published pages that actually carry the adapter contract, the capability
    protocol, and the platform command matrix.
  - `@namzu/cli`'s README linked to a session folder on the code host that
    returns 404, to explain the doctor's protocol/runtime split. The split is now
    explained in the sentence itself.
  - `@namzu/sdk` source comments cited design documents by path. They cite the
    session by name instead, which is what the reference was ever worth.

  No API, type, or behaviour change. The `@namzu/sandbox` message text is the
  only runtime string affected, and nothing asserts on it.

## 1.0.0

### Patch Changes

- Updated dependencies [542f057]
- Updated dependencies [df09910]
- Updated dependencies [140bcc0]
- Updated dependencies [ea21863]
- Updated dependencies [38c4b62]
- Updated dependencies [265150b]
- Updated dependencies [a1c6694]
- Updated dependencies [52af97e]
- Updated dependencies [a71422a]
- Updated dependencies [d6b5bc1]
- Updated dependencies [8fd9349]
- Updated dependencies [63e44f7]
- Updated dependencies [63b4885]
- Updated dependencies [38c4b62]
- Updated dependencies [6b74cd0]
- Updated dependencies [d86b161]
  - @namzu/sdk@1.0.0

## 0.2.1

### Patch Changes

- c9b180d: Coordinated patch bump across all publishable packages after the `@namzu/telemetry@0.1.0` extraction landed. No functional changes — this is a compatibility and release-pipeline validation cut to (a) exercise the Trusted Publisher binding for `@namzu/telemetry` that was configured after the 0.1.0 bootstrap publish, and (b) give consumers a single aligned set of patch versions that all know about the new telemetry package.

  Resulting versions:

  - `@namzu/sdk` → `0.4.1`
  - `@namzu/telemetry` → `0.1.1`
  - `@namzu/computer-use` → `0.2.1`
  - `@namzu/anthropic`, `@namzu/bedrock`, `@namzu/http`, `@namzu/lmstudio`, `@namzu/ollama`, `@namzu/openai`, `@namzu/openrouter` → `0.1.2`

## 0.2.0

### Minor Changes

- 40eb841: Move `@namzu/sdk` from `dependencies` to `peerDependencies`.

  Previously, `@namzu/computer-use@0.1.0` declared `@namzu/sdk` as a direct runtime dependency (`workspace:^`), which meant a consumer installing both packages would end up with **two concurrent copies of `@namzu/sdk`** in `node_modules` — the one they installed themselves and the one computer-use resolved. This produces symbol-identity bugs (two separate `AgentManager` classes, two separate `RunEvent` schemas, etc.) that surface as hard-to-diagnose "instanceof fails" at runtime.

  The correct shape, matching the 7 provider packages, is peer + dev:

  - `peerDependencies`: `@namzu/sdk: ">=0.1.6 <1.0.0"` — consumer provides, resolved once.
  - `devDependencies`: `@namzu/sdk: workspace:^` — for local dev and type-checking.

  **Consumer migration:** if you previously relied on `@namzu/computer-use` pulling `@namzu/sdk` in transitively, install it explicitly:

  ```
  npm install @namzu/sdk @namzu/computer-use
  ```

  This is technically a breaking change (the transitive resolution no longer works), but pre-1.0 SDK context and the runtime-corruption risk of the old shape justify correcting it as a minor bump.

All notable changes to `@namzu/computer-use` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-15

### Changed

- First stable release from the `cogitave/namzu` monorepo. Ships with the full subprocess computer-use host from 0.0.1; package is now published under the `latest` dist-tag with full provenance attestations.
- Released via tag-prefix scheme: `computer-use-v*` triggers `.github/workflows/release-computer-use.yml`.

## [0.0.2-rc.1]

### Changed

- Pre-release smoke test for the new monorepo release pipeline. Verified `npm trust`-based provenance publishing end-to-end. Functionally identical to `0.0.1`.

## [0.0.1]

### Added

- Initial release. `SubprocessComputerUseHost` implementing `ComputerUseHost` from `@namzu/sdk`.
- Platform adapters: `darwin`, `linux-x11`, `linux-wayland`, `win32`.
- Capability probe per adapter with honest degradation (missing binaries → `AdapterUnavailableError` at construction; missing optional deps → capability flag false).
- Display-server detection via `process.platform` + `XDG_SESSION_TYPE` / `WAYLAND_DISPLAY` / `DISPLAY`.
- Unit test coverage for key-combo translation across adapters and display-server detection.
