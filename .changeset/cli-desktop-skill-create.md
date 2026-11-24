---
"@namzu/cli": minor
---

You can now create and save a skill from the Desktop app. Ask Namzu to make one (or use Settings, Skills, New skill, or `skills new` in the message box), answer its questions, and a card shows the whole file, where it would be saved and what it would replace; nothing is written until you pick "Save to my skills" or "Save to this project". The skill is usable from your next message. No setting or permission mode answers that card for you. Nothing breaks: a conversation without an app to confirm in (`namzu exec`, scheduled runs, sub-agents) still has no `save_skill`, and the built-in `skill-creator` now shows the draft and says saving is not available there instead of telling you to open a terminal. `save_skill` no longer needs a `search_tools` call first, and a question about whether Namzu can make skills is answered directly.
