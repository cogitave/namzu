---
"@namzu/cli": minor
---

The terminal's title now says what the conversation is, as in the reference terminal. It reads `✳ <name>` while Namzu waits (`◐` while a turn runs), where the name is the one you gave with `/rename`, else the title the small model wrote, else `Namzu`, and it is reset when Namzu exits so your shell's title comes back. Before, Namzu never touched the title. Set `NAMZU_DISABLE_TERMINAL_TITLE=1` to keep the title as your shell had it.
