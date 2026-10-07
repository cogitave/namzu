# Transcript trial: streaming Markdown, chat scroll, virtualisation (2026-10-07)

Sandbox: `.../landscape/trials/transcript/` (npm, react 19 + react-dom 19). Nothing installed in the Namzu repo. Scripts: `check.mjs`, `c2.mjs` there. All checks are Node SSR (`renderToString`) and package inspection. NOT done: no browser/DOM run, so use-stick-to-bottom, virtua, react-virtuoso were only import-checked, not behaviour-tested; streamdown timing is SSR-only.

## Facts (npm view / install)
| pkg | version | license | last publish | module | React peer | postinstall/native | dir size |
|---|---|---|---|---|---|---|---|
| streamdown | 2.7.0 | Apache-2.0 | 2026-09-30 | ESM | ^18 or ^19 | none | 152K (+14 deps: marked 18, remend, rehype-raw, rehype-sanitize, rehype-harden, remark-gfm, tailwind-merge, ...) |
| remend | 1.4.0 | Apache-2.0 | 2026-09-30 | ESM | none | none | 48K, zero deps |
| @streamdown/code (optional) | 2.0.0 | n/c | n/c | ESM | - | none (dep shiki ^4.4.3) | not installed |
| use-stick-to-bottom | 1.1.6 | MIT | 2026-06-04 | ESM, sideEffects:false | 16-19 | none | 68K, ~20KB JS |
| virtua | 0.53.3 | MIT | 2026-10-06 | ESM+CJS | >=16.14 (optional other frameworks) | none | 2.9M (all frameworks; react part 68K) |
| react-virtuoso | 4.18.16 | MIT | 2026-09-29 | ESM+CJS | 16-19 | none | 260K |
| @tanstack/react-virtual | 3.14.13 | MIT | 2026-09-14 | ESM+CJS | 16-19 | none | 96K (+virtual-core) |
| react-markdown (ours) | 10.1.0 | MIT | 2025-03-07 | ESM | >=18 | none | 88K |

Whole sandbox: 121 packages, 26M, 0 vulnerabilities, no `.node`/`.gyp` files, no install scripts in any candidate. All are pure JS, so none hurts Windows delivery. Note react-markdown has had no release since March 2025.

## Namzu today (read)
- `renderer/message.tsx`: `react-markdown` + `remark-gfm` (+`remark-frontmatter` in document view) + own `remarkCodeCopy`, `skipHtml`, custom `a/pre/code/img/table` components, link-preview popovers, resolved file refs (only after `settled`). Wrapped in `memo`. The whole text is re-parsed on every streaming delta.
- `renderer/use-transcript-scroll.ts` (103 lines): follow flag, 48px threshold, wheel/touch/key cancel, rAF-coalesced ResizeObserver, smooth jump with `scrollend`, reduced-motion aware, "jump to latest" state. Small and already handles the user-scrolls-away case.
- `renderer/transcript.tsx`: plain `groups.map`, no virtualisation. `@tanstack/react-virtual` is used only for the file/changes trees.
- Code fences in chat are rendered by our `MarkdownCode/MarkdownPre`; I did not verify whether highlighting is applied.

## Streaming Markdown results
Unterminated input, rendered with react-markdown (ours) vs streamdown 2.7 (`mode=streaming`):
- Open code fence: both render a code block with the partial text (react-markdown natively). No healing needed.
- Open table (last row short): react-markdown renders the row with an empty cell; header-only/delimiter-only prefix renders a header-only table. Acceptable, no flicker evidence available without a DOM.
- Open `**bold and \`cod`: react-markdown shows literal `**`; streamdown/remend heals it, but remend's output `**bold and \`cod**\`` is wrongly nested (the `**` lands inside the code span, so the bold is not applied; `**` shown literally).
- Open link `[the docs](https://exam`: react-markdown shows raw text plus an autolink; remend rewrites to `[the docs](streamdown:incomplete-link)`, a sentinel URL our `a` component and urlTransform must recognise (streamdown renders it as a disabled-looking button). Images likewise become `streamdown:incomplete-image` (react-markdown then emits `<img src="">` and React warns).
- remend defect: `text with 2 * 3 * 4 and snake_case_name_ and a_b` becomes `... a_b_` (a stray underscore appended to plain text). Also `~~strike`, nested `*ita` heal correctly. Content where `_` appears in identifiers is common in our coding transcripts, so remend must be fuzz-tested before adoption. (Possibly fixed in a later version; I tested 1.4.0 only.)
- XSS posture: our `skipHtml` drops `<script>`, `<img onerror>` and raw tags entirely; `javascript:` link becomes `href=""` (react-markdown default urlTransform). streamdown by default does NOT drop raw HTML: `<b>raw</b>` was rendered as a real `<b>` (rehype-raw + rehype-sanitize + rehype-harden); script and `onerror` image were neutralised and the javascript: link blocked. It exposes `skipHtml?`, `rehypePlugins`, `urlTransform`, `components` props (index.d.ts lines 108-115), so a skipHtml-equivalent is configurable, but the default posture is looser than ours and a sanitize-schema bug would be our risk. Verdict: acceptable only with `skipHtml` set and tested.
- Styling/coupling: streamdown output carries its own Tailwind classes, copy/download buttons, table wrapper, `content-visibility:auto` on code blocks, and its own link-safety button. Our `chat-markdown` CSS, `remarkCodeCopy`, link-preview popovers, resolved file refs, document mode and table `section` wrapper all need reimplementing as `components` overrides. Large integration cost.
- Shiki: not bundled; needs `@streamdown/code` (shiki 4). Namzu already ships shiki through `@pierre/diffs`, so a second shiki copy/version is a risk to check.
- Cost (SSR, 40 growing renders of a 5.6KB doc): react-markdown+gfm+skipHtml 478 ms, streamdown 1545 ms (about 3x slower; Node SSR only, not a browser measurement, and streamdown's block-memoisation benefit appears in React updates, which SSR cannot show).

The honest finding: streamdown's real advantage is splitting into blocks and re-rendering only the last one. We can get that without it, by splitting the text at blank lines outside fences (`marked`'s lexer or a 20-line splitter) and memoising each block with our existing `MarkdownBody`. That keeps our components, skipHtml, link/file-ref handling.

## Scroll
`use-stick-to-bottom` 1.1.6 exports `StickToBottom`, `useStickToBottom`, `useStickToBottomContext`; 20KB, no deps, MIT, ESM. It uses spring-animated scrolling and ResizeObserver, same mechanism as ours. Not behaviour-tested here (no DOM). Our hook already covers: threshold, wheel/key/touch escape, reduced motion, jump-to-latest. Adopting means replacing our `follow` ref contract (other code reads `follow.current`) for no demonstrated gain.

## Virtualisation
Transcript is unvirtualised today. Chat rows have highly variable, streaming-changing heights and the bottom-follow logic depends on real scrollHeight, which is where virtualisers cause trouble (jumpy scroll, find-in-page failing, text selection across rows lost). Candidates, from docs/API only (not benchmarked): virtua (VList, built-in `shift` for prepend and `reverse`-style chat support, dynamic heights, 68K React), react-virtuoso (best chat ergonomics: `followOutput`, `initialTopMostItemIndex`, larger), @tanstack/react-virtual (already a dep, manual measurement; weakest for chat). Not measured: no transcript size at which Namzu actually lags was established.

## Recommendation
- streamdown: KEEP react-markdown; do not adopt. Reasons: 3x slower SSR parse, looser HTML default, heavy styling/component re-plumbing, second shiki.
- remend: DO NOT adopt as-is. Trial only behind a fuzz test (nested code/bold, identifier underscores); the two defects above are real. If we want inline healing, write a small healer or pin a fixed remend after verifying. The sentinel `streamdown:incomplete-*` URLs must be handled in `a`/`img`.
- Block-level memoisation: ADOPT (own code) as the streaming-cost fix. Measure in the real app first.
- use-stick-to-bottom: KEEP our `use-transcript-scroll.ts`.
- Virtualisation: KEEP unvirtualised for now. Try `content-visibility:auto` on settled turns first (CSS, zero deps, keeps find/selection). If a measured long-thread problem remains, trial virtua first (smallest React footprint, chat-oriented), react-virtuoso second; stay off @tanstack/react-virtual for the transcript. Needs a real Electron PTY/dogfood trial, which this sandbox could not do.
