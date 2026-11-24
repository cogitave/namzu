---
"@namzu/cli": minor
---

New setting `computerUse.browserWindows` (`look`, `ask`, `act`; default `ask`). Computer use could only look at a browser window you had open, and Namzu's own browser has none of your sign-ins. Now the first action aimed at a browser window in a conversation asks you whether Namzu may click and type in it for this conversation, and only your answer allows it (no permission mode answers it, and a scheduled or unattended run stays look-only). Set `look` to keep the old behaviour. A project file can only tighten the setting.

Looking at a browser (a screenshot, a list of windows) never asks. The Desktop host also offers `namzu/session/revoke-browser` so a browser taken back in Desktop is taken back in the engine too.
