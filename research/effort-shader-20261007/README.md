# Effort slider shader

The filled part of the composer's effort slider is a WebGL2 ordered-dither surface (`packages/desktop/src/renderer/effort-shader/`). It was chosen from two candidates (`prism-dither` beat `pixel-aurora`), with the brand-accent ramp, the 8x8 Bayer density gradient, the pale light-theme off-cells and the calm drift grafted in from the loser.

## What it does

- 2 CSS px dither cells (DPR capped at 2), Bayer 8x8 threshold; density rises along the fill as `t^1.5` and with the level.
- Ramp along the fill: deep green, teal, the accent (`--primary`), then a hot mint end that grows with the level.
- Drifting noise plus a slow band; drift `0.05 + 0.22*level`, so low stays calm.
- Sparkles rise and twinkle: density `0.012 + 0.07*level`, stronger toward the thumb.
- Bloom at the thumb, `max(0.12, smoothstep(0.55, 1, level))`: a faint pulse at low, a full glow with a dithered rim spilling past the thumb at the top levels.
- A faint dithered idle shimmer on the unfilled track, so Low is never empty.
- Value changes ease on the CPU (progress 70 ms, level 260 ms, visibility 120 ms time constants).
- Theme and accent are read once and again on a `MutationObserver` over the root `class`/`style`/`data-theme`; no per-frame `getComputedStyle`.

## Fallbacks

| Situation | Result |
|---|---|
| No WebGL2 or shader fails | plain CSS fill |
| `webglcontextlost` | CSS fill returns at once; `webglcontextrestored` rebuilds the program and the shader returns |
| `prefers-reduced-motion` | one static frame, values snap, no loop |
| Document hidden | loop pauses, resumes on show |
| Panel closed | component unmounts, canvas removed, `loseContext()` called |

The CSS fill stays visible until the first frame has drawn (`data-shader="on"` on the panel), so there is no flash. The canvas is `pointer-events: none` and `aria-hidden`.

## Numbers

`requestAnimationFrame` deltas over 120 frames, headless Chromium with swiftshader (software GL), top level, DPR 2: mean 16.7 ms, p50 16.7, p95 16.7, max 16.8. That is the page cadence, not isolated GPU time. A real GPU was not available here.
Context loss and restore were forced with `WEBGL_lose_context`: `data-shader` went `on`, `null` (see `dark-context-lost-css-fallback.png`), `on`.

## Screenshots

`artifacts/{dark,light}-level-{0..n}-{low,medium,high,...}.png` for each level the preview model offers (three at present), and `{dark,light}-top-t{0,400,800}.png` for three frames (0, 400, 800 ms) at the top level.

## Rerun

```
pnpm --filter @namzu/desktop dev:preview     # serves http://127.0.0.1:5173/preview
node research/effort-shader-20261007/capture.mjs research/effort-shader-20261007/artifacts
cd packages/desktop && pnpm exec vitest run src/renderer/effort-shader
```
