---
'@namzu/sdk': patch
---

Close the `ask_user_question` contract, and prove the enforcement hint reaches the wire.

The second half of the same revert. `ask_user_question` lost `.strict()` on both its root object and its option items, along with `modelInputSchema`, `enforceModelInput` and `validationErrorHint`.

The failure that specifically motivated them is a model serializing `options` — sending `"[{\"label\":\"Board\"}]"` where an array belongs. A model that does it once tends to keep doing it, and the parse error it gets back never says the array was the problem. The closed schema makes a capable provider refuse at generation time, and the recovery hint names the shape to retry with. Without `.strict()` an unknown key was silently stripped, so a misspelled field became a no-op nobody could see.

The enforcement path is now covered end to end: a request carries `enforceToolInputSchema` naming exactly the tools that opted in, follows the allowed set rather than everything registered, and omits the field entirely when nothing opted in — an empty array would read as "enforce nothing" rather than "nothing asked", and a driver cannot tell those apart. That coverage is what was missing when the producer was deleted and three drivers went on reading a field nothing set.
