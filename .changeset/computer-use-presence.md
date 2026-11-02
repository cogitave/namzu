---
"@namzu/computer-use": minor
---

On Windows, while a window is being operated you now see an agent cursor (a pixel-art arrow, separate from your real pointer) and a dithered border around that window. Both are click-through, never take focus, stay out of the taskbar and out of screenshots, and fade a few seconds after the last action or when the turn ends. They are on by default. To turn them off, pass `presence: false` to `SubprocessComputerUseHost` or set `NAMZU_COMPUTER_USE_PRESENCE=off`. If the overlay cannot start, or Windows cannot keep it out of screen captures, nothing is shown and actions are unaffected.
