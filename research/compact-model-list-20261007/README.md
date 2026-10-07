# Compact model list (2026-10-07)

Playwright screenshots of the preview (http://127.0.0.1:5173/preview, 1100x760), opened with the model trigger, then the model link in the effort panel.

- dark-list.png, light-list.png: 16 sample models, 30px rows, list capped near 60% of the window, no refresh, Retry or "Use a model ID" row; engine chip and search button share the heading.
- dark-search.png, light-search.png: search open (28px field, 12px text) after pressing `/` and typing.
- dark-failed.png, light-failed.png: catalogue read fails (localStorage `namzu.preview.models` = `fail`); one muted line, no button.

Compared with images/23.png (ours before): the Retry text button, the refresh icon and the "Use a model ID" row are gone and rows are shorter. Against images/2.png (Codex) the row density now matches.
