---
'@namzu/cli': patch
---

Esc on an open `/` or `@` suggestion menu now closes the menu and leaves what you typed alone; it no longer shows "Esc again to clear" or wipes the draft on the next press. In a Ctrl+R history search, Esc now leaves the search with the match you found in the box, and Ctrl+C goes back to the draft that was there before. Tab right after Esc closed a menu brings the menu back instead of sending the half-typed command.
