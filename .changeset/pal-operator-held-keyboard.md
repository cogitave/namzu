---
"@namzu/sdk": minor
"@namzu/sandbox": minor
---

Add opt-in held keyboard input for a Pal's operator-controlled guest. Providers
advertise `heldKeyboard: true` only after negotiating the owned guest's support;
`PalComputerInput` then accepts session-scoped `key_down`, `key_up` and
`release_keys`. Providers must release their tracked held keys before confirming
returned Pal authority. Existing complete `key` taps and AI `computer_use`
actions keep their behavior, and older local images do not advertise holds.

The desktop captures a new keyboard lifetime for each focus session, forwards
press and release events without replaying browser key repeats, and releases
only that lifetime on focus/view loss. Cleanup retains exact Pal/generation and
operator authority checks and cannot release another lifetime's keys. Rebuild
the local Pal image to enable this capability; a runtime update alone retains
the older image's tap input.
