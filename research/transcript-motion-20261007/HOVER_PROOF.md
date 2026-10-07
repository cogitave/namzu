# Fixed transcript hover geometry

The current hover proof is [hover-fixed-layout-564aaf64-ce37969e.json](artifacts/hover-fixed-layout-564aaf64-ce37969e.json). Its seven renderer source files stayed unchanged during that run. The transcript CSS SHA-256 is `df4b65b57e95eceeaf32074fb22798b9de1aeaab2f135b5db383684135d99b93`. A later App-only pending-reader correction has separate final-source proofs below; this receipt does not claim that its earlier App fingerprint matches the final App.

## Conditions and results

The actual Desktop renderer runs in an isolated loopback Vite preview with fixture history and synthetic ACP events. Chromium's animation timeline is paused; actual CSS animations are inspected at explicit fractions, and JavaScript timers advance through the Playwright virtual clock.

| Viewport | Theme | Motion | Hover/focus variants |
| --- | --- | --- | --- |
| 1280 × 900 | Dark | Normal | 7 |
| 640 × 720 | Light | Normal | 7 |
| 560 × 640 | Dark | Normal | 7 |
| 640 × 720 | Light | Reduced | 7 |

Each scenario covers the user bubble, assistant message, commentary, reasoning, tool clock, tool duration and work header. At rest, start, quarter, midpoint, completion, pointer leave, interrupted re-entry and keyboard focus, the proof compares exact clock/duration dimensions, row bounds, parent and neighbour bounds, chevron location, transcript scroll position, scroll range and total content height. All stayed constant. Known clocks reserve a `40.359375 × 16.5` px slot in this fixture; missing clocks remain absent.

Normal hover changes clock opacity over 160 ms, with no width or height transition. Opacity measured `0 → 0.684643 → 1` at start, midpoint and completion; interrupted reversal remains continuous. Keyboard focus reveals the clock with an immediate 2 px outline. Reduced motion creates no opacity transition. Open/close disclosure height and opacity still use the separate 260 ms symmetric transition; interrupted reopen, cached-history navigation, live/settled headers and visible expanded body also passed. There were no browser page errors.

Authoritative expanded screenshots include [minimum dark](artifacts/minimum-dark-settled-expanded-df4b65b5-ce37969e.png) and [wide dark](artifacts/wide-dark-settled-expanded-df4b65b5-ce37969e.png). Their file hashes and visible body bounds are in the receipt. The minimum expanded screenshot and [narrow light user-hover midpoint](artifacts/564aaf64-ce37969e-narrow-light-user-bubble-hover-middle.png) were visually inspected.

## Historical evidence and limits

[The initial fixed-slot run](artifacts/hover-fixed-layout-564aaf64-210a2171.json) is retained unchanged. Wide dark passed, then narrow light failed because the baseline user bubble was offscreen and Playwright's hover auto scrolled it by 110 px. Its clock dimensions and total content height were already constant. The runner now prepares a visible reader position through the app's scroll/follow event handlers before capturing the baseline; the strict geometry comparisons were preserved. This isolated preparation performs no direct storage writes.

Earlier `motion-proof.json` and draft receipts document older dimensional hover behavior and are historical evidence, not the current contract. This proof makes no reference-app pixel-parity, native-update, model-performance or provider-execution claim. It sends no provider requests and performs no native actions. The separate persistence proof and native receipts remain unchanged.

Reproduce from the repository root:

```sh
node research/transcript-motion-20261007/motion-proof.mjs .
```

Each run writes unique source-bound receipt and screenshot names without overwriting prior evidence.

## Native verification

The parent agent separately verified the same CSS in the running Windows desktop app; see [native-css-delivery.json](artifacts/native-css-delivery.json). Actual native Chromium forced CSS hover measured a `40.359375 × 16.5` px clock and opacity `0 → 0.684643 → 1 → 0`. Clock, message row and parent geometry remained exact, with `scrollTop=1388` and `scrollHeight=2242` throughout. This used no pointer movement, restart, reload, provider request or message-body read. Metrics unavailable for this final-message target remain `null`; the isolated matrix covers neighbouring rows, composer boundaries and chevrons.

The receipt retains the failed delivery checks, including a one-time 0.5 px reader-anchor quantization mismatch. The successful subsequent hover verification did not relax geometry comparisons. Native stylesheet delivery does not establish that the later App pending-scroll fix is activated.

## Pending reader races

The subsequent actual App regression proof is documented in [PENDING_SCROLL_PROOF.md](PENDING_SCROLL_PROOF.md). It verifies the newer App source separately from this CSS matrix: navigation while cold history is held preserves the old reader; real wheel, PageUp and manual work disclosure supersede pending restoration; plain programmatic scroll does not. The subsequent full compiled Desktop delivery and its verification limits are recorded in [NATIVE_UPDATE.md](NATIVE_UPDATE.md).
