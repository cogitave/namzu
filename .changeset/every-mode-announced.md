---
'@namzu/cli': patch
---

The model is now told when Auto (and Strict) mode starts and ends, like Accept edits and Bypass, and hears about a mode change once, after the conversation, instead of also through a system message that re-read the whole conversation on every Shift+Tab. The end of a mode is worded for the mode you land in, and a sub-agent is told its calls follow the session that started it, with that session's person deciding, rather than that it may ask the user. Nothing to change in your setup.
