---
"@namzu/computer-use": major
---

On Windows and under WSL, `SubprocessComputerUseHost` now drives the desktop through cua-driver (MIT, github.com/trycua/cua) instead of starting `powershell.exe` for every action, and every adapter now takes and returns physical pixels. Both are changes a caller can see; read on before upgrading.

**What changes by default on Windows / WSL.** The first `initialize()` downloads cua-driver 0.28.2 for the machine's architecture (a 27–29 MB archive from the project's GitHub releases), checks the SHA-256 of the archive and of `cua-driver.exe` against values pinned in this package, and keeps only the executable in `<NAMZU_HOME>/computer-use/cua-driver/0.28.2/` (`~/.namzu` unless `NAMZU_HOME` is set). One `cua-driver.exe` process then runs until `host.dispose()`; call `dispose()` when you are done. It runs with its telemetry and release check off and without environment variables whose names look like secrets. If it cannot be downloaded, verified or started, the host falls back to PowerShell and says why in `host.fallbackReason`.

To keep the old behaviour — no download, no long-lived process — set `NAMZU_CUA_DRIVER=off` or pass `new SubprocessComputerUseHost({ windows: { backend: 'powershell' } })`. To use a cua-driver you installed yourself, set `NAMZU_CUA_DRIVER=<path to cua-driver.exe>` or `windows: { cuaDriverPath }`. `windows: { download: false }` uses only a cached or configured build.

**Physical pixels everywhere.** Points you pass to `execute()` and sizes you get back are pixels of the captured bitmap, as the SDK's host contract now states. This changes results only on scaled displays:
- macOS Retina: `getDisplayGeometry()` returns the backing resolution (2880x1800, not 1440x900), `cursor_position` is in pixels, and click/move/drag points are pixels; the adapter divides by the scale factor for `cliclick`. If you converted screenshot pixels to points yourself, stop.
- Windows above 100 % scaling: both backends are DPI aware, so the capture is the whole display (it was the top-left part) and points are physical (they were DPI-virtualised).
- Every capture now carries `result.display` (`id`, origin, size, `scaleFactor`).

**Also new.** With the cua-driver backend, `capabilities.windows` is `true` and `host.listWindows()` / `host.focusWindow(id)` work (focus restores a minimised window and reports what is actually in front); `host.captureRegion()` exists and throws where the adapter has no region capture. `host.backend` names the backend in use. Measured on a 3440x1440 display: a click went from 0.68–0.83 s to 0.13 s, a screenshot from 0.40 s to 0.08–0.13 s.

**Smaller differences on the cua-driver backend.** `capabilities.clipboard` is `false` (no clipboard action was ever offered); `win`/`super` in a key chord press the Windows key (PowerShell's SendKeys pressed Ctrl); a single punctuation key such as `/` is typed as text so the keyboard layout cannot change it. Only the primary display is captured, as before. The PowerShell fallback now types text through Unicode key events instead of SendKeys, so `+ ^ % ~ ( ) { }` and non-Latin text arrive as written.
