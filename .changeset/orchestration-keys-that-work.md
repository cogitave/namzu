---
"@namzu/cli": patch
---

Three places in the delegated-work screens named a key or text that did not work or was cut off:

- An agent's `ctrl+o result` row that had scrolled into history could not be opened. Now, once the live bodies are open, the next Ctrl+O opens the newest settled body in the output viewer, and ←/→ move to the others. With nothing settled, the second press still just folds the live bodies.
- While an approval dialog is open, the reduced agents rail no longer shows `↓ / ctrl+t`. The dialog holds both keys, so neither reached the rail.
- On an 80-column terminal the effort slider's `<highest> + delegate by default` sub-label moves left so it fits on screen instead of being cut. The spend warning wraps instead of being cut. The rows it uses stay reserved on the other stops, so the picker keeps the same height when the caret moves.

No configuration or API changes.
