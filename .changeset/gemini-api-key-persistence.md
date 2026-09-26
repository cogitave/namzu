---
'@namzu/cli': major
---

Gemini API keys pasted into Namzu are now saved automatically in its private credential store and reused on later launches. This changes the former session-only default. To keep a key out of Namzu's store, provide it through a per-process `GEMINI_API_KEY` environment variable instead of pasting it into the picker. `namzu logout gemini` or `/logout gemini` removes the saved key; an environment variable remains under your control.
