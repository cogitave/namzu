# Changelog

## 4.3.0

### Minor Changes

- 95533ac: On Windows, a keyboard-and-mouse helper that has stopped no longer takes the screen path down for the rest of the session. A helper that ended is replaced before the next use; a run whose first look or start fails because the helper died is repeated once with a fresh helper, and a start that fails is retried once. After two failed starts in a row the failure is remembered until the turn ends, so the model is not charged a PowerShell compile per retry. If the helper dies in the middle of an action, that action fails with "the keyboard-and-mouse helper stopped during the action" and is not restarted inside itself.

  The `monitor_unavailable` message now names the cause (could not start PowerShell, exit code and last error line, or a blocked compile with the PowerShell language mode) instead of "the Windows helper exited". It no longer tells `ui_act` callers to use `ui_act`: those paths say the control could not be pressed in the background and to try another control or ask the user, while display and window actions still say controls by ref work.

  Nothing breaks for existing callers. `ForegroundMonitor` gains an optional `running` member (a custom monitor that leaves it out is treated as always running; return `false` once yours can no longer answer to have it replaced), `ForegroundBlock` gains an optional `reason`, and `HelperProcess.onExit` handlers may now receive `{ code, signal, stderr, spawnError }`; a handler that ignores its argument keeps working.

## 4.2.1

### Patch Changes

- d8e426d: After `ui_act` on a control, the wait for the window to settle now counts from a change marker taken just before the action, as it already did for a coordinate input. Until now only coordinate inputs took the marker, so a control action fell back to the tool's fixed 500 ms pause even with the accessibility host up. Nothing changes for a caller: the pause is shorter when the window stops changing sooner, and unchanged when the host is off or fails.

## 4.2.0

### Minor Changes

- 126828d: On Windows, the driver backend now keeps a second resident helper (an accessibility host) that answers the window list in under a millisecond instead of 1.3 to 1.75 s through the driver, and lets a window input be followed by waiting for the window to stop changing (about 130 ms after a change) instead of the tool's fixed 500 ms pause; a window that does not change still takes the full pause, so it is never slower. If the helper cannot start or fails, the driver answers exactly as before, in the same call; set `NAMZU_COMPUTER_USE_A11Y=off` (or `a11y: false` on `SubprocessComputerUseHost`) to turn it off. Chromium and Electron windows are never read through it unless a caller asks (`allowChromium`), because reading one switches that program's accessibility on. `@namzu/computer-use` also exports the platform-neutral `AccessibilityBackend` types and `A11Y_ENV`. `@namzu/sdk` gains the optional `ComputerUseHost.settle(request, signal)` with `ComputerUseSettleRequest` and `ComputerUseSettleResult`: the `computer_use` tool asks it before the screenshot that follows an action and sleeps `settleMs` only when it is absent, answers `undefined` or fails; `settleMs` and its default of 500 are unchanged, so a host that does not implement it behaves as before.

## 4.1.1

### Patch Changes

- 3b52063: On Windows, the agent's cursor and the frame around the window it is working in look and move like part of a modern app. The cursor is a smooth green arrow with a soft shadow that stays the same size on a 150 % or 200 % display; it fades in the first time it appears and glides to each spot along a gentle curve, a little longer for a longer trip. A click makes it dip and send out a round ripple, and typing sends out a smaller, softer one. The frame is a smooth rounded outline with a soft glow inside it that breathes slowly while the agent is active and fades out with the cursor, in place of the old dotted square edge. It also stops redrawing when nothing is moving. Nothing changes in how you turn it off (`presence: false` or `NAMZU_COMPUTER_USE_PRESENCE=off`) or in what the model sees: the overlay is still left out of every screenshot.

## 4.1.0

### Minor Changes

- b19db83: The computer-use tool can double-click and triple-click, and a Windows window can be scrolled in the background. `mouse_click` takes an optional `count` (an integer from 1 to 3; 1 when omitted), and `ComputerUseCapabilities` gains `maxClickCount?: 1 | 2 | 3`, the most clicks in a row one `mouse_click` may make. The model is offered `count` only when a host declares a `maxClickCount` above 1; a `count` above the host's cap is refused with a message naming the cap before the host is touched, and a `count` above 1 with the right or middle button is refused. A multi-click reaches `ComputerUseHost.execute` and `executeWindow` as `count` on the `mouse_click` action only when it is above 1. The Windows driver backend in `@namzu/computer-use` now declares `maxClickCount: 3` and `windowScroll: true`: a window scroll is posted to the window by the driver instead of being refused, and the scroll's point is sent only when the scroll runs in the foreground. Nothing changes unless a host declares `maxClickCount`: a host without it clicks once per action exactly as before, and a custom host that never set `windowScroll: false` sees no difference.

## 4.0.2

### Patch Changes

- 3521f7e: A click, key or text typed into a Windows window now asks the desktop driver for fewer window lists. The driver's list of windows takes over a second on a real desktop, and one input used to read it up to six times: before the send, for the check that the window had not moved, and at each of the four waits that look for the input's effect. It is now read once before the send (the same list also answers the moved-window check), and afterwards only at the first wait, at the last wait, and at any wait where the window's own contents changed. An input the driver confirms itself now costs one list instead of two; one it cannot confirm costs three instead of six. Every refusal and every outcome is unchanged: a window that moved, closed, was minimized or changed owner is still refused with the same message and nothing is sent, and the result is still `delivered_verified`, `delivered_unverified` or `not_delivered` on the same evidence. The reads of the window's contents are unchanged. One difference: a new window of the same program that opens and closes again between the checks, while the window it came from shows no change, is no longer noticed. Nothing to change in your code.

## 4.0.1

### Patch Changes

- 7db536c: The Windows desktop driver Namzu downloads is now cua-driver 0.38.0 (it was 0.28.2): a 36 MB archive for x64 or 33 MB for arm64, checked against the hashes pinned in the package as before. The first `initialize()` on a machine that has the old copy fetches the new one into `<NAMZU_HOME>/computer-use/cua-driver/0.38.0/`; the old folder is left where it is and can be deleted. The window UI tree is now read with the driver's `full_output` flag, because 0.35 stopped returning the structured element list unless asked. Nothing to change in your code.

## 4.0.0

### Major Changes

- 880586f: On Windows, computer use no longer takes the screen from a person who is using it. Input that cannot be delivered in the background (a web page's keys, a covered window, a window that needs real focus, anything sent with `delivery_mode: "foreground"`, display-scope input and `focus_window`) now waits until the user has had no real keyboard or mouse input for 2 s, holds a cross-session lease on the screen, is watched for the user's input while it runs, and afterwards puts back the previous window and pointer, but only if nobody touched input meanwhile.

  What changes for the model: a blocked action comes back as "Not delivered" and safe to retry, naming what blocks it (the user is busy, another session holds the screen, the user said no, a lock screen or administrator prompt is in front, the target runs with higher rights). A background action that had to use the screen says so and for how long. If the user presses Escape during one, every later `computer_use` call of that turn returns the same stop message until the next turn. When the user stays busy for 15 s they are asked once whether the application may use the screen for a moment; where nobody can be asked (exec, scheduled runs) the action parks and retries for up to 120 s and then says what blocks it.

  What changes for a host: `ComputerUseHost` gains optional `beginTurn(turnId)` and `endTurn()`; `FocusWindowResult` gains optional `delivery`, `retrySafety` and `detail`. All are additive. `SubprocessComputerUseHost` takes `foreground: { approve?, session?, timing? }` and exports `ComputerUseStoppedError`. Breaking default in `@namzu/computer-use` (hence the major): an action that used to reach the screen at once (a display click, `focus_window`, `delivery_mode: "foreground"`) now waits for a still moment and can come back as not delivered; the value that changed is the idle wait before display input and `focus_window`, from none to 2 s; to keep the old behaviour for a script that owns the machine, pass `foreground: { timing: { idleMs: 0, approvedIdleMs: 0 } }`. The CLI asks the one question through its question card.

- 880586f: `computer_use` now says what it knows about each action instead of reporting a call that returned as "done", and works from a window's controls first.

  What changes for the model: an action reports `done, verified` only when the host read the state back, `sent, not confirmed` when the input went out and nothing could check it (look before repeating, because repeating can act twice), and a failure marked "Not delivered" when nothing reached the target (safe to try again). `data.steps[]` carries `delivery` (`delivered_verified`, `delivered_unverified`, `not_delivered`) and `retrySafety` (`safe`, `unsafe`). A new `wait_for` action (element, text or window condition, bounded) replaces fixed waits and returns the window's controls with fresh refs. The tool text leads with `list_windows`, `ui_snapshot`, `ui_act`; the first coordinate click in a captured window gets a reminder, not a refusal.

  What changes for a host: `UiActResult` gains optional `delivery`, `retrySafety` and `readBack`; `executeWindow` may return a `WindowInputResult`; a display `{ type: 'ok' }` may carry `delivery`, `retrySafety` and `detail`. All are additive and optional, so an existing host keeps working and keeps the plain `done`. `ComputerUseHost.executeWindow` is now declared as returning `Promise<void | WindowInputResult>`; a wrapper that annotates it as `Promise<void>` and discards the result still compiles, but one that forwards it should use the wider type.

  What changes in the Windows backend (`@namzu/computer-use`): `set_value`, `toggle` and `select` read the control back and are verified or not delivered by what the window then shows; `set_value` on a field with no settable value is "not delivered" and no longer types into it as a fallback; a click that leaves another window in front, and window input the driver could not confirm, are "sent, not confirmed" instead of done; a refused background input is "not delivered" with what to do next. Refs of a window stay valid after a read-back. If your own tooling parsed the old "typed into the empty field" detail or relied on those cases counting as success, read `delivery` instead.

  This is `major` for `@namzu/computer-use` because an outcome a caller could rely on changes: the `set_value` fallback to typing is gone, former successes become failures or unconfirmed results, and a driver error the backend cannot classify is now reported as "sent, not confirmed" and unsafe to repeat rather than "not delivered". To keep the old behaviour, read `ok` only and ignore `delivery`; nothing restores the typing fallback.

### Minor Changes

- 880586f: Computer use on Windows now says "done, verified" for inputs that worked but the driver could not confirm, types into classic text boxes in the background, and puts your window back after it used the screen.

  A press, a key or typed text in a window is read back by what the window shows afterwards: typed text that now appears, or a change that followed the input, held still, and was not happening before it, is `done, verified (reads "…")`; nothing observable stays `sent, not confirmed`, and an unrelated change is never taken as the effect. `set_value` on a classic Win32 edit control and `type_text` into a window whose focused control is one are sent as window messages and read back with the control's own text, with no focus change; a program running with higher rights refuses them and the result is `not_delivered` with the reason. A list the driver's value call does not change (a web page's select element) is chosen with the keyboard through the idle-gated foreground ladder and read back, else the result names the browser tool. After a foreground burst the previous window is restored whenever the target took the front, including when Windows refused the helper's own raise, and the result says why when it could not be.

  For a host: `WindowInputResult` gains an optional `readBack`, additive. `ForegroundMonitor` gains an optional `editText`; `encodeHelperCommand` now encodes only the bootstrap, and `helperScriptLine` gives the script line written first to the helper. Nothing to change unless you call those directly.

- 880586f: Computer use on Windows now stops when you interrupt it, says plainly when an administrator window swallowed its typing, and refuses to act on a locked computer.

  Interrupting a turn (Esc) ends a pending desktop action at once instead of waiting for the driver: an action that may already have been sent is reported as sent, not confirmed and unsafe to repeat, one that was not sent yet as not delivered and safe, and the window and pointer it borrowed are put back only after the driver has stopped acting. When a window running with higher rights is in front, input sent from here is dropped by Windows without any error; Namzu now detects that (the window's integrity level beforehand, and whether the system registered the input afterwards) and reports "An administrator window is in front; Namzu cannot type into it" as not delivered and safe to repeat. A locked computer (lock screen, sign-in screen or a secure prompt) is refused before anything is read or sent, and a screenshot taken while it locked is discarded. The desktop driver's own cursor is switched off so only Namzu's is shown.

  For a host: every desktop-reaching `ComputerUseHost` method (`execute`, `listWindows`, `focusWindow`, `captureWindow`, `executeWindow`, `captureRegion`, `uiSnapshot`, `uiAct`) gains a trailing optional `signal?: AbortSignal`, additive; a host that ignores it keeps working. `MonitorState` gains optional integrity fields, `MonitorBurstEnd` gains optional `inputMoved` and `frontElevated`, and `@namzu/computer-use` exports `ComputerUseLockedError`. Nothing to change unless you implement a host or a foreground monitor.

- 880586f: On Windows, while a window is being operated you now see an agent cursor (a pixel-art arrow, separate from your real pointer) and a dithered border around that window. Both are click-through, never take focus, stay out of the taskbar and out of screenshots, and fade a few seconds after the last action or when the turn ends. They are on by default. To turn them off, pass `presence: false` to `SubprocessComputerUseHost` or set `NAMZU_COMPUTER_USE_PRESENCE=off`. If the overlay cannot start, or Windows cannot keep it out of screen captures, nothing is shown and actions are unaffected.
- 880586f: A `ui_snapshot` ref now names a control and survives later snapshots, a large window is shown as an outline you open one region at a time, and an action on a ref that no longer fits fails with a typed reason instead of acting on whatever is there.

  What changes for the model: refs (`e12`) no longer die at the next `ui_snapshot`. `ui_act` finds the control again by its id, its place in the tree, then its role and name, and only then sends anything; if the control has gone the step fails with `STALE_REF`, and if several controls fit it fails with `AMBIGUOUS_TARGET`. Both mean nothing was sent, so it is safe to take a new snapshot and choose again. A window with more than about 220 controls comes back as an outline in which a region is marked `(+N more inside)` and has a ref; `ui_snapshot { root: <ref> }` reads that region alone (`offset` for the next page of a long one) and leaves every other ref usable, and `ui_snapshot { query: <text> }` lists only matching controls. The advice to "read a smaller window" is replaced by "drill into a region".

  What changes for a host (additive and optional): `ComputerUseHost.uiSnapshot(windowId?, options?)` takes `UiSnapshotOptions` (`root`, `offset`, `query`); `UiElement` gains `hiddenChildren`; `UiSnapshot` gains `outline`, `total`, `region` and `next`; `UiActResult` gains `code` (`UiActFailureCode`: `STALE_REF`, `AMBIGUOUS_TARGET`). A host that ignores the new options keeps working: its refs are simply treated as stable for as long as it keeps them valid. The tool no longer discards the refs of earlier snapshots, so a host that reuses a ref string for a different control must not.

  What changes in the Windows backend (`@namzu/computer-use`): refs carry identity evidence (automation id, role and name, tree path, window) and are re-resolved against a new read when older than 3 s, when a newer read of the window replaced the driver's handle, or after a driver restart; the same id under a different name is not accepted as the same control. The window is walked with the driver's own 5 000 node cap, a browser window is read once more when its first walk shows only the frame, and a control that holds nothing is no longer made the parent of rows the driver reported below a skipped level. Code that relied on an old ref being refused after the next snapshot, or on the exact wording "not a control of the latest ui_snapshot", should read `code` and `delivery` instead. This is `minor` for `@namzu/computer-use`: the refusal of an old ref has become a successful re-resolution, which no documented contract promised to preserve.

  The CLI's permission review reads the new `ui_snapshot` fields (`root`, `offset`, `query`) as the read-only requests they are, instead of asking about an unknown field.

- 880586f: Selecting a file row in a folder window now selects it and no longer opens it. `ui_act select` on a list or tree row that can also be invoked goes through the row's selection pattern and is verified by reading the row back as selected; where that cannot be reached nothing is sent and the result says a click would open the row. Text typed in the background into a window that was never activated is delivered again (the window's single edit control is used when its thread has no focus window). A caller that relied on `select` opening a file should use `invoke`.

  A background input that the window provably did not react to is now sent once more on the screen (through the idle gate, lease and restore) and its result is `sent, no effect seen` and safe to repeat if that also does nothing; a result that said `sent, not confirmed` for such an input before now says so only when the window changed in a way that cannot be tied to the input. A shortcut with a modifier that matches an item of the window's classic menu is carried out as that menu command without pressing a key. `ForegroundMonitor` gains an optional `menuCommand`; a custom monitor is unaffected. A key or mouse button held down now counts as the person using the computer.

  An input is no longer sent a second time on the screen when the window read cannot show that it did nothing: a read with a cut text or a cut walk, Enter, Backspace, Delete, Space and Ctrl+Z/Y/X/V, and a shortcut carried out as a menu command are reported `sent, not confirmed` instead.

### Patch Changes

- 880586f: The agent cursor and presence border now also appear on a window that was opened after the overlay helper started (before, such a window got neither), they are placed correctly on displays scaled above 100%, and a helper that ends mid-session is started again by the next action instead of leaving the overlay off for the rest of the session. Nothing to change on your side.
- 880586f: A `ui_act` ref to one of several identical controls (same role and name, no id) no longer acts on a neighbour after the window changes: it answers `AMBIGUOUS_TARGET` and sends nothing, so take a new `ui_snapshot` and use the ref it gives. A window handle that another program reuses no longer adopts the old program's refs, a `query` snapshot no longer overwrites where existing refs were found, and one read creates at most 1,000 new refs. A paged outline no longer repeats nameless containers on the next page.
- 880586f: Computer use on Windows no longer reports typed text as delivered because an unrelated label changed, no longer types into a dialog that happens to share the program, no longer stops a run when the front window cannot be read, and no longer tells the model that input was dropped (and is safe to repeat) unless an administrator window was actually in front. A cancelled action stops waiting for a helper that does not answer.

## 3.1.0

### Minor Changes

- 072bb74: Windows computer use can capture pixels for one named window with `screenshot {window_id}` and keep background clicks and drags, text and keys bound to that window. Window `type_text` and `key` can explicitly request `delivery_mode: 'foreground'` for browser text or modifier shortcuts that cannot run in the background; this may briefly bring the verified window forward. The pinned driver sets `windowScroll: false` and refuses scoped pixel scrolling because its wheel input cannot prove which window receives it; a host that supports safe window scrolling can offer it. Capture identity and window geometry are checked before input; moved windows, old captures and restarted driver sessions require a new window screenshot. Hosts can offer window capture without display capture, in which case `window_id` is required and plain display screenshots remain unavailable. A failed window capture never broadens to a display capture. When both browser and computer-use tools are ready, the CLI routes a named existing browser window to computer use, leaving browser tools for the separate Namzu-managed profile.

## 3.0.0

### Major Changes

- c8bb87a: The Windows cua-driver backend now revives an implicit session after its five-minute idle expiry and retries a call that the driver explicitly refused before dispatch. UI Automation snapshots now return adapter-owned refs instead of raw cua-driver element tokens. Callers passing raw tokens to `uiAct` must use refs from the latest `uiSnapshot`; old refs cannot address a different control when the driver reuses a token after session revival or process restart. Calls whose outcomes are unknown are still not retried automatically.

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
    session by name instead, which is all such a citation was ever worth.

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
