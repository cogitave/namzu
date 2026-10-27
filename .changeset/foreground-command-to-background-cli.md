---
'@namzu/cli': major
---

Esc no longer stops a shell command the model is running in the foreground: the command moves to a background job and keeps running, and the row says `Interrupted · The command continues in the background`. It shows under `/jobs` and is announced when it ends. To end it, stop it from `/jobs`. To keep the old behaviour of Esc killing the command, start Namzu with `NAMZU_DISABLE_BACKGROUND_TASKS=1` (this also stops the model from starting background jobs).

New: once a command has run for two seconds its row hints `(ctrl+b to run in background)`, and Ctrl+B moves it to the background. With no such command Ctrl+B is still cursor-left. Sending a message (Enter) while a command runs also moves it, so the message reaches the model without waiting for the command to end.
