# Transcript streaming cost and following the end

Wave 3 of the [tool-landscape plan](../ai-tool-landscape-20261007/PLAN.md): what a streamed
reply costs the renderer in a long conversation, and what changed. Measured in a real
Chromium against the real Desktop renderer (the `/preview` entry), never in Node SSR.
No virtualisation was added: the numbers below do not show a long-thread problem once the
per-delta work is bounded.

## What changed

| Where | Change |
|---|---|
| `renderer/markdown-blocks.ts` | Pure splitter: cut at blank lines outside fences; never inside a fence (unterminated included), before an indented line, between two items of one list, or after indented code; whole text when a link or footnote definition, an HTML block or a bare-CR line ending is present. |
| `renderer/message.tsx` | `MarkdownBody` renders one memoised `MarkdownBlock` per piece with one stable component map; only the tail re-parses. `skipHtml`, link cards, file refs and code copy are unchanged. Documents (front matter, relative links) are parsed whole. |
| `renderer/throttled-text.ts` | A live reply's text changes what is drawn at most every 50 ms (leading and trailing edge); a settled reply shows its text at once. |
| `renderer/transcript.tsx`, `transcript-memo.ts`, `rendered-equal.ts` | A turn that is not being written is skipped when its own data is unchanged. This also fixes a cache that never held: the per-turn line totals were keyed on an inline handler, so they were recomputed on every render. |
| `renderer/use-transcript-scroll.ts`, `scroll-follow.ts` | Every scroll the code makes is marked, so its echo is not read as the reader leaving the end (OpenCode); opening a disclosure stops following while it grows and resumes if the reader is still at the end, or if they were following, did not scroll and the panel is under a third of the view (a fast stream outgrows the 48 px threshold in the 260 ms the panel takes; found in review, `adv-disclosure.mjs`). |
| `renderer/transcript-motion.css` | `content-visibility: auto` with `contain-intrinsic-block-size: auto 400px` on finished turns except the last two. |
| `dev/preview-stress.ts`, `dev/preview.ts` | `/preview?stress=300`: 300 settled turns and `window.namzuPreviewStress.start()`, a timer-driven streamed reply (788 deltas of 24 characters, 12 paragraphs with lists, fences and tables). Nothing runs without the flag. |

Remembering the position per conversation with an at-end flag already existed
(`follow` and `scrollTop` in the workspace presentation of `app.tsx`); it was not duplicated.

## How it was measured

`measure.mjs <label>` starts its own Vite server (HMR off, so edits elsewhere cannot reload the
page), opens 300 turns, scrolls through them, jumps to the latest, checks anchors, goes to the
end the way a reader does, then streams the reply while recording `PerformanceObserver`
`longtask` entries, rAF frame deltas, the time from each delivered delta to the next DOM
mutation, the scroll gap to the end every 250 ms, and CDP `Performance.getMetrics`.

- `REACT=production` serves the production React build while keeping the dev-only preview
  entry (the installed app runs production React; dev React adds element stacks and checks).
- `BASELINE=1` swaps in the HEAD copies of `message.tsx`, `transcript.tsx`,
  `use-transcript-scroll.ts` and `transcript-motion.css` (`git show HEAD:<path>` saved next to
  each as `<name>.baseline.<ext>`, which are not kept).
- `profile.mjs` aggregates a CPU profile; `follow.mjs` and `disclosure.mjs` are smaller checks.

Headless Chromium with SwiftShader on WSL2, 1280x900, one run per cell. Treat differences of a
few percent as noise; the differences below are 5x to 10x. Wall time is not a quality measure:
the stream is a 16 ms interval and, when the main thread keeps up, finishes in about that time.

## Results (788 deltas, 300 settled turns above)

| | Production React before | Production React after | Dev React before | Dev React after |
|---|---|---|---|---|
| Long tasks (count, total) | 323, 19.8 s | 2, 0.6 s | 418, 70.1 s | 25, 1.9 s |
| Longest task | 100 ms | 518 ms (end of stream) | 435 ms | 115 ms |
| Frames over 33 ms | 401 of 734 | 3 of 378 | 559 of 756 | 69 of 619 |
| Mean frame | 36.9 ms | 18.2 ms | 105.8 ms | 20.0 ms |
| Main-thread task time per delta | 34.4 ms | 6.2 ms | 101 ms | 15.7 ms |
| Script time per delta | 28.5 ms | 3.9 ms | 95 ms | 13.7 ms |
| Delta to DOM, mean / p95 | 60 / 82 ms | 33 / 58 ms | 177 / 320 ms | 50 / 102 ms |
| Largest gap to the end while streaming | 4915 px | 161 px | 6208 px | 99 px |
| Gap to the end after the stream | 4905 px | 0 | 6179 px | 0 |
| Stream wall time | 27.1 s | 6.9 s | 80.1 s | 12.5 s |

Delta-to-DOM includes the deliberate 50 ms throttle, so it understates the gain. The 518 ms
task is the end of the stream: the thread's state is replaced by the saved history and every
turn draws once.

Where the main thread went (CPU profile, 4-paragraph reply, production React, `artifacts/profile-*.txt`):
inclusive time of `Button` fell from 590 ms to 71 ms because the 300 action rows no longer redraw;
what remains in `transcript.tsx` is the comparison of 300 turns (about 100 ms over the run).

Contribution of each step on dev React (an earlier harness, `artifacts/md-throttle.json`): block
memoisation and the throttle alone cut script time from 113 s to 88 s; the rest came from skipping
unchanged turns. The Markdown parse was not the dominant cost on a 16 KB reply; the draw of the
whole tree per event was.

What is still outside this track: every event still renders `App`, the sidebar and the tab strip
(`Button`, `sidebar-motion`, `PanelResizeHandle` in the profile). Coalescing events per frame in
`app.tsx`'s `onEvent` would cut that further.

## Anchors and `content-visibility`

| Check | Before | After |
|---|---|---|
| `scrollIntoView` to turn 150 from the top | in view | in view |
| Jump to latest from the top | gap 0 | gap 0 |
| `window.find` for text in turn 220 | match selected | match selected |
| Scroll through all turns, mean / max frame | 16.9 / 66.7 ms (prod) | 16.9 / 50 ms (prod) |
| Scroll height of 300 turns | 182,913 px | 120,989 px until each turn has been seen once |

`window.find` selected the match in both, but headless Chromium did not scroll it into view in
either, so find-in-page is only shown to reach into skipped content, not to scroll to it. There
is no in-transcript find yet (wave 8); it must force-render the match's turn. The shorter
scroll height is the 400 px stand-in for turns not yet seen; the browser remembers each real size
(`auto`) after the first draw.

## Tests

`markdown-blocks.test.ts` (unit cases, a fixed-seed generator over 800 documents, and an
equality check of rendering blocks against rendering the whole text; a one-off run of 30,000
generated documents also passed), `throttled-text.test.ts`, `scroll-follow.test.ts` (fake
timers), `transcript-memo.test.ts`, `rendered-equal.test.ts`, and the reworked reconciliation
cases in `message.test.ts`.
