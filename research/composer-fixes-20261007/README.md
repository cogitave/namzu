# Composer input fixes

[proof.mjs](proof.mjs) drives the real Desktop renderer in an isolated loopback Vite preview (headless Chromium, sample catalogue, no native or provider calls). The preview refuses device files, so attachments are held in memory by a stub installed before the app loads. Results are in [proof.json](artifacts/proof.json); there were no page errors.

```sh
node research/composer-fixes-20261007/proof.mjs .
```

| Fix | Result | Screenshot |
| --- | --- | --- |
| 1. A real Ctrl+V of a clipboard with text and an image rendering inserts the text | pass | [paste](artifacts/1-paste-text-with-image.png) |
| 5. Removing a chip moves focus to a remaining remove button, then to the editor after the last one | pass | [before](artifacts/5-chips-before-removal.png), [after](artifacts/5-focus-after-last-removal.png) |
| 6. Clicking Send returns focus to the editor (focus log: Send focused, then the editor) | pass | [send](artifacts/6-focus-after-send.png) |

Limits: the preview refuses to send, so the draft is not cleared in check 6; only the focus handoff is proved (the draft clearing is covered by unit tests, not this script). Disabled and copy states for points 2, 3, 4 and 7 are covered by unit and markup tests, not by this script.
