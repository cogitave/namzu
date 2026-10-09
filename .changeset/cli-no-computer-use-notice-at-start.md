---
"@namzu/cli": patch
---

The terminal app no longer opens with "Computer use is unavailable in this session: The
openai provider cannot return images in tool results…" when the chosen provider cannot
show screenshots. The reason still travels with the computer-use tool, so the model
tells you the moment computer use is actually asked for. A desktop that cannot start at
all is still reported when the session opens.
