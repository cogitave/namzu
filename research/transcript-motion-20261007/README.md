# Transcript motion proof — 2026-10-07

The renderer proofs run against the actual Desktop Vite renderer. They check the requested work disclosure and the hover/open/close motion in the DOM without running a model, touching the native app, or reading an actual user conversation. Separate guarded native checks are documented in [NATIVE_UPDATE.md](NATIVE_UPDATE.md).

**Current hover behavior:** known clocks and durations reserve their space and change only opacity; hover, reversal and focus leave the surrounding layout and reader position fixed. See the [current fixed-slot proof](HOVER_PROOF.md), its [source-bound receipt](artifacts/hover-fixed-layout-564aaf64-ce37969e.json) and [current wide expanded image](artifacts/wide-dark-settled-expanded-df4b65b5-ce37969e.png). The original motion measurements below describe the earlier dimensional-hover source and remain as historical evidence.

Run from the repository root:

```sh
node research/transcript-motion-20261007/motion-proof.mjs .
```

## Fixture and reference scope

The fixture reuses the isolated SDK journal and current CLI/ACP mapping in `../transcript-search-timing-20261007/artifacts/journal-fixtures.json`. Hosted search comes from the qualified provider-hosted ACP update, and the earlier-message lookup retains the exact `search_conversation` tool identity and public synthetic query. No command subgroup or source URL is invented from metadata.

The live sequence is synthetic: commentary, completed tools, then actual pending reasoning. Its controlled clock reads six seconds while running, and it settles at fifteen seconds. Those durations test presentation; they are not measured provider latency. The user's supplied screenshots establish the requested composition: a muted timed work header with a hairline, commentary/actions inside, the current Thinking phase separately at the bottom, and the final answer outside the disclosure. No reference app DOM or pixel parity is claimed for those images.

The previous audit's local WAI geometry and live BeautifulUI/AI Elements reference captures remain in `../transcript-search-timing-20261007/`. This audit adds measured local motion rather than claiming that its easing reproduces an inaccessible reference animation.

## Deterministic animation sampling

Chromium's Animation domain is set to playback rate zero before interactions. The proof inspects actual CSS transitions and Web Animations on the real elements and seeks their `currentTime` to explicit fractions. Playwright's virtual JavaScript clock advances Base UI timers and animation-frame callbacks. Assertions do not race a wall-clock deadline or infer smoothness from the duration of a tool call.

The historical `artifacts/motion-proof.json` includes source SHA-256 fingerprints before and after its complete run. `sourceStayedFixed` is true for that run. It records the computed dimensions, opacity, colors, backgrounds, target rectangles, native animation types, transition properties, keyframes, and interruption points of that earlier source. Screenshots include hover rest/start/middle/end, panel intermediate states, live work with Thinking, and completed work collapsed/expanded.

## Historical four-scenario motion checks

Four scenarios passed with no browser page errors:

| Scenario | Viewport | Appearance | Motion preference |
| --- | --- | --- | --- |
| wide-dark | 1280 × 900 | Dark | Normal |
| narrow-light | 640 × 720 | Light | Normal |
| minimum-dark | 560 × 640 | Dark | Normal |
| reduced-light | 640 × 720 | Light | Reduced |

The ordinary panel opens over 260 ms through actual height and opacity transitions. The 140 px saved-work fixture measures **0 → 70 → 140 px**, with opacity **0 → 0.5 → 1**, at start/middle/end. Closing reverses those values. A reopen during closing starts at the exact interrupted height and opacity, then returns to the full panel without a reset or stale closing effect. Reduced motion changes state immediately with no panel transition.

In this earlier receipt, hover metadata transitioned width, height and opacity over 160 ms. A clock measured **0 → 22.42 → 40.36 px** at start/quarter/end; halfway opacity was approximately 0.6846. Mouseleave and immediate re-entry continued from the same intermediate size and opacity. The [current fixed-slot receipt](artifacts/hover-fixed-layout-564aaf64-ce37969e.json) supersedes those dimension measurements: its clock slot stays **40.359375 × 16.5 px** at rest and throughout hover, with only opacity changing. Tool-row backgrounds had real 150 ms intermediate colors in both themes; label and icon colors stayed stable. The header stayed muted and transparent. Header and tool chevron targets remained fixed. Keyboard-focused clocks appeared immediately with a visible 2 px outline.

With pointer and focus outside the transcript, this earlier source had an **8 px** commentary-to-tool gap at every tested width because hidden clocks occupied zero height. That gap is a historical observation, not a measurement of the current stable clock slots.

Live work reads **Working for 6s** once, with the actual **Thinking** phase below and no second elapsed counter. Completed work reads **Worked for 15s**; the final answer remains outside the collapsed or expanded work panel. Cached history navigation restores the saved content without transcript admission or phase animations; no wall-clock speed threshold is asserted.

After the narrow visual correction, visible Update/Reasoning captions are absent. Public commentary and reasoning use the primary foreground: computed **rgb(245, 245, 245)** in dark and **rgb(39, 39, 42)** in light. Tool labels remain muted at **rgb(129, 129, 129)** / **rgb(113, 113, 123)**. ARIA group labels and data identities remain available.

The earlier completed expanded screenshots were captured only after checking the panel was open, displayed, fully opaque and positive in height. Every commentary/tool/reasoning child passed `checkVisibility`, had positive height and fit inside the panel; the answer began below it. That source's final body was 141.5 px high, ending at y360.25 with the answer starting at y378.25. Its unique expanded filenames end in **`4445ea19.png`**, the earlier CSS hash prefix. The current fixed-slot proof uses **`df4b65b5`** source-bound expanded images linked in [HOVER_PROOF.md](HOVER_PROOF.md).

Each historical `settled-rendered-body` receipt links its authoritative screenshot filename and image SHA-256. Use [the earlier expanded image](artifacts/wide-dark-settled-expanded-4445ea19.png) only with that receipt. Unqualified screenshot paths were overwritten during draft runs and can produce stale cached views; the current [source-bound expanded image](artifacts/wide-dark-settled-expanded-df4b65b5-ce37969e.png) belongs to the fixed-slot receipt.

## Manual work disclosure and reader restoration

The later native restart exposed a separate defect: manually opened work panels were not saved with the conversation view, so the reader's restored position could be clamped against a shorter, collapsed history. The focused proof uses the actual App with long public synthetic histories and no native/provider operation:

```sh
node research/transcript-motion-20261007/motion-proof.mjs . --persistence-only
```

[The earlier focused receipt](artifacts/disclosure-persistence-c42b0c05-b861a89a.json) passed two checks with zero browser page errors. It fingerprints that run's App, Transcript, workspace presentation, scroll hook and shared motion sources before and after the run. Source bytes stayed fixed. Its screenshot filenames include a source hash and a run identity, and every screenshot carries an image hash. [The final-source rerun](artifacts/disclosure-persistence-e0661714-2e79d0ad.json) also passed; [PENDING_SCROLL_PROOF.md](PENDING_SCROLL_PROOF.md) documents its App fingerprint and five additional held-history cases.

Two work segments in the same ordered turn expose distinct manual keys, `[1,"message-1"]` and `[1,"message-4"]`. Owner A retains **open/open**. A different conversation deliberately uses those same keys but retains **closed/open**, including an explicit `false`; its view cannot borrow Owner A's choices.

After navigating to the other cached tab and back, Owner A keeps reader message `message-5`, `scrollTop=1147`, and a top offset of `-23.703125 px`. A full renderer reload pauses the authoritative history read on a controlled deferred promise. The loading tree has zero work headers, and it leaves the saved disclosure map and scroll position intact. Releasing that exact promise restores the two open panels, the same message, the same offset, and `follow=false`. Owner B independently retains message `message-8`, `scrollTop=1869`, and `-11.40625 px` after Owner A's reload. The proof asserts identity and geometry, rather than a wall-clock speed threshold.

The earlier four-scenario motion receipt and its images remain unchanged. That matrix ran against its recorded earlier Transcript component. The restoration change left the CSS, motion hook and Collapsible source bytes unchanged; its focused receipt did **not** claim a complete motion rerun. The subsequent [fixed-slot hover proof](HOVER_PROOF.md) checks hover and disclosure motion against its own source fingerprints, while the separate persistence receipt above checks cached tabs and held history reload.

## Preserved evidence

`artifacts/motion-before.json` preserves the first draft measurements: the 240 ms front-loaded frame was already about 88% open at its temporal midpoint, and hover dimensions changed immediately while only opacity animated. That early capture then stopped on a fixture-clock assertion because installing the virtual clock replaced the fixture's `Date.now` override; the error was in the proof harness, not a product timing claim.

`artifacts/motion-draft-ease-out.json` preserves the complete earlier draft run. The later `motion-proof.json` corrected that draft's easing and commentary gap while still growing hover dimensions; the [current fixed-slot proof](HOVER_PROOF.md) supersedes that hover behavior. No native update was performed by these renderer proofs.
