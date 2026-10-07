# Composer controls proof

The model and effort trigger, the effort panel, the model list and the permission chip, run against the real renderer in the design preview (sample data, no provider requests). `proof.mjs` makes the keyboard and state assertions (34 checks); `shots.mjs` takes the screenshots and writes [measurements.txt](artifacts/measurements.txt). Both need the preview served at `http://127.0.0.1:5173/preview` and are run from this folder with `node proof.mjs` and `node shots.mjs`. Every image below was looked at.

| Condition | Screenshot |
| --- | --- |
| Codex, dark 1280 x 900: trigger "GPT-6.1 Sol Medium" | [trigger](artifacts/codex-dark-1-trigger.png) |
| Codex, dark: effort panel with the slider | [effort](artifacts/codex-dark-2-effort.png) |
| Codex, dark: model list with the Default row, all nine rows visible | [models](artifacts/codex-dark-3-models.png) |
| Codex, dark: permission menu | [permissions](artifacts/codex-dark-4-permissions.png) |
| Codex, dark: Full access chip | [chip](artifacts/codex-dark-5-full-access-chip.png) |
| Claude Code and Namzu, dark | [claude effort](artifacts/claude-dark-2-effort.png), [claude models](artifacts/claude-dark-3-models.png), [namzu effort](artifacts/namzu-dark-2-effort.png), [namzu models](artifacts/namzu-dark-3-models.png), [namzu permissions](artifacts/namzu-dark-4-permissions.png) |
| Codex, light 640 x 720 | [trigger](artifacts/codex-light640-1-trigger.png), [effort](artifacts/codex-light640-2-effort.png), [models](artifacts/codex-light640-3-models.png), [permissions](artifacts/codex-light640-4-permissions.png), [Full access chip](artifacts/codex-light640-5-full-access-chip.png) |
| Namzu, light 640 x 720 | [trigger](artifacts/namzu-light640-1-trigger.png), [effort](artifacts/namzu-light640-2-effort.png), [models](artifacts/namzu-light640-3-models.png), [permissions](artifacts/namzu-light640-4-permissions.png) |
| Pal, 560 wide: effort panel over the Plus popup | [pal](artifacts/pal-560-effort.png) |

## Measured

- The effort panel and the model list have the same width per engine (300 px, 360 px with the Namzu provider column) and no descendant leaves the popup, which stays inside the window.
- Switching views eases the height: list to effort goes 362, 261, 197, 163, 146, 138, 134, 132 px over eight frames (Codex), where it used to jump in one frame.
- The slider thumb slides: 846, 888, 911, 920, 924, 926 px after one ArrowRight (the fill follows), where it used to move in one frame.
- The Codex model list has nine rows and no scrolling (list scroll height 318, client height 318); with twelve models or fewer there is no search, refresh or typed-id control.
- Full access uses the warning token: rgb(255, 185, 0) in dark, rgb(187, 77, 0) in light. Permission rows per engine: Codex four, Namzu four, Claude Code two.
- Keyboard (`proof.mjs`): arrows move the highlight without committing, Enter commits and returns to the effort panel, Escape closes and returns focus to the trigger, Home and End jump to the ends, a saved effort is kept when the new model offers it and dropped when it does not.
