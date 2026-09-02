---
"@namzu/cli": major
---

Fewer slash commands: what a key already does is not also a command, and what one command already shows is not also another.

**Removed** (38 → 26). Each line names what to use instead.

- `/expand [n]` → **Ctrl+O**. Opens the collapsed tool bodies still on screen in place; once they have scrolled away it reprints the most recent one in full. The collapse hint now reads `… +N lines · ctrl+o`. Numbered reopening of older bodies is gone with the numbers.
- `/agent` → **Ctrl+T** (the delegated-work inspector; the command had already been hidden from help).
- `/clear-screen` → **Ctrl+L**.
- `/mention` → type **`@`** in the composer.
- `/quit` → `/exit`.
- `/title` → `/rename`; `/rename clear` removes the saved name.
- `/skill` → `/skills` (`/skills <name>` activates directly).
- `/provider`, `/pwd` → `/status`, which already shows both.
- `/tools` → `/status tools`.
- `/debug-config` → `/status config`.
- `/remember <text>` → `/memory <text>`; bare `/memory` still shows what is remembered.

A removed spelling is answered with "Unknown command: /x. Try /help." rather than silently sent to the model as prose. Scripts and muscle memory that used one of the old names are what this breaks; nothing else on the surface changed.

Kept on purpose: `/new` (a fresh conversation that leaves the screen alone is a different act from `/clear`), `/raw` (a distinct rendering mode with no key), `/effort` (the scriptable form of Shift+↑/↓).
