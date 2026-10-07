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
