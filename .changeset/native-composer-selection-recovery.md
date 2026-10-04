---
'@namzu/cli': patch
---

Reset Codex reasoning effort to the selected model's actual native default when
Default effort is selected, including after a model change. Refuse an omitted
effort when the native model catalogue supplies no valid default, rather than
silently retaining a previous turn's effort. Admit the native Codex review modes
already advertised by its adapter; Claude Code retains its supported Ask first
and Plan modes.

Retain the actual completed native final-answer identity in Codex terminal
receipts and history reconciliation so successful turns no longer erase
streamed replies when the terminal notification contains no text.
