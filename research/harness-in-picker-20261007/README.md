# Engine choice in the model popup

Playwright (chromium, swiftshader) against the live preview, `proof.mjs`. Dark is 1440x900, light is 900x720. Files are `<theme>-<n>-<name>.png`.

| # | Shows |
|---|-------|
| 1 | Started conversation: no tray above the box |
| 2 | New conversation: tray with project and "This computer", no engine chip |
| 3 | Effort panel: title left-aligned (effort above model link), engine chip on the right, no reset icon |
| 4 | Effort moved to High |
| 5 | After double-clicking the thumb: back to Medium, the model default (value text "Medium (default)") |
| 6 | Engine view on a new conversation: check on the current engine, Back reads "Effort" |
| 7 | Model list with the engine chip in its heading |
| 8, 9 | Started conversation: effort panel, then the engine view with "Opens in a new tab" on the other engines |
| 10 | After choosing Codex on a started conversation the original tab is untouched (the choice opens a new conversation) |
| 11-13 | That new Codex conversation: engine icon before the model name, effort panel chip, Codex checked |

Console output of the run: no tray on a started conversation, one on a new one, no engine control inside the tray, 3 stops with exactly 1 marked default, no "Use default effort" button, value text "Medium (default)" at the default stop, High after a click on the last stop, Medium after the double-click.

Not shown by a screenshot: the 150ms exit of the tray. The preview cannot send from an empty draft (its composer stays disabled) and drops a draft when tabs are restored, so the flip from empty to started could not be driven there. The CSS was checked by setting `data-leaving` by hand (animation `composer-tray-out`, height 54px to about 3px, opacity to 0).

## Adversarial review additions

- Switching from a new draft to a saved conversation made the tray collapse over ~190ms; `usePresence` now takes the session as a scope and drops the tray at once on a session change.
- `usePresence` also unmounts after 600ms if `animationend` never arrives, so the tray cannot stay stuck.
- Backspace/Delete on the effort slider resets to the default (the earlier note claimed it, but it was missing).
- Opening the engine view now puts focus on the current engine row, so arrows and Enter work immediately.
- Screenshots: `adv-light-effort-after-drag.png`, `adv-light-engine-view-focus.png`.
