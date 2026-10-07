# Link preview cards (2026-10-07)

Actual-renderer proof of the hover/focus link card in assistant replies. An isolated loopback Vite server serves the real renderer; `window.namzu` is mocked (`linkPreview`, `linkPreviewImage`, call counts recorded). Requests to anything but loopback are aborted and logged. No network, provider or native call.

Rerun from the repo root (first `pnpm install && pnpm -r build`; strip `/mnt` from `PATH` on WSL):

    cd packages/desktop && node ../../research/link-preview-20261007/proof.mjs ../..

`artifacts/proof.json` records every check; the script asserts them and exits non-zero on failure.

Conditions: wide dark 1280x900 (rich, no-details, slow, cached re-hover, inline-code URL, keyboard), narrow light 560x720, reduced motion vs normal.

| Check | Result file |
| --- | --- |
| No request before hover; one request after hover; cache on re-hover | `checks.cache` |
| Rich card: site, title, description, image, address, inside viewport | `card-rich-wide-dark.png`, `card-rich-narrow-light.png` |
| No-details card: host + address, no error wording | `card-null-wide-dark.png` |
| Slow link: skeleton, then final content | `card-loading-wide-dark.png` |
| Keyboard: Tab opens, Escape closes, focus stays on the link | `checks.keyboard` |
| Scroll position and message box identical before/while/after | `checks.layout` |
| Reduced motion: transition is `none` | `checks.reducedMotion` |
| No page/console errors, no external requests | top-level arrays |

## Native Windows delivery (2026-10-07)

`native/native-desktop-update.cjs` replaces only the owned app's `app\dist` (no CLI, SDK or dependency change). Public receipts in `native/artifacts/` hold counts, hashes, PIDs and timings; drafts and message text stay in private snapshots inside the Windows Development directory.

| Step | Receipt | Outcome |
| --- | --- | --- |
| Read-only state check | `check-state-only-20261007T114512412Z.json` | passed: one idle tab, empty saved draft equal to the composer |
| Preflight against the new build | `check-20261007T115303478Z.json` | passed: 7 changed, 18 added, 2 removed Desktop files |
| Apply | `apply-20261007T115321424Z.json` | **failed after the graceful close**: the process probe treated PowerShell's exit 1 for an already-exited process as an error. The staged copy had already matched the source manifest and `app\dist` was untouched. |
| Manual completion | — | the verified stage was renamed into `app\dist` (previous dist kept as `dist-before-link-preview-20261007T115321424Z`) and `launch.cjs` started PID 16076. The probe now ends with `exit 0`, and a failure after the close relaunches the app. |
| Read-only comparison with the before snapshot | `verify-after-20261007T115424403Z.json` | **failed**: the open conversation shows 8 messages instead of 9. The missing one is a cancelled assistant reply that was visible live; its text is in the session journal (`message_started`/`message_completed` with `stopReason: cancelled`) but cold history does not rebuild it. Every other message keeps its role and text hash. This predates the link cards and is tracked as a separate history fix. |
| Native network probe | `probe-only-20261007T115530556Z.json` | passed: GitHub and Hugging Face heads with `og:title`/`og:image`, a 87 KB share image and a 33 KB icon sniffed as PNG, a cached repeat in 0 ms; `localhost`, `127.0.0.1`, `192.168.1.1`, `http:`, port 8443 and `metadata.google.internal` all refused. |

The installed `app\dist` manifest equals the built source, and the preload exposes both link preview methods. No model request, UI interaction or computer action was made.
