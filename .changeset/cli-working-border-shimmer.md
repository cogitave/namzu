---
"@namzu/cli": patch
---

Show a short, fading green light around the message frame while Namzu is working. The light follows multiline input and terminal resizing without moving or resetting the draft. It stops when the turn ends or another input surface takes focus, and stays off for non-interactive or color-disabled terminals and screen readers. The Working indicator and border use one shared animation scheduler.
