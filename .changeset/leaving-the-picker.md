---
'@namzu/cli': minor
---

Leaving the provider picker takes you back where you were

The picker has two entry points and had one exit between them.

**`/model` then `Esc` no longer throws away your session.** Cancelling sent you
to the phase namzu uses for "I tried and cannot serve" — a screen with a
disabled composer, from which `/model` cannot be typed again. Declining to
change model cost you the working session you already had. It now returns to the
chat.

**`Ctrl+C` works in the picker.** The key handler was switched off for the whole
picker phase, so on the first screen a new user sees, the interrupt did nothing
useful: one press armed an exit whose "press again" notice is printed into a
transcript the picker does not render, and only a second press left. It exits on
the first press now, and the hint names it.

**`Esc` on first run exits.** There is no screen behind the picker then, so
leaving the picker is leaving the program — which is what the empty picker's
footer has always said `esc` does.

The hint now says which of the two `Esc` means: `esc keep current` when a
session is behind it, `esc or Ctrl+C exit` when nothing is.
