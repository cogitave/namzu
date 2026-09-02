---
"@namzu/sdk": minor
---

The repeat-call tracker refuses one thing. It advised on identical calls and never denied one, so a model that asked a desktop it could not reach for a screenshot, read the same error and asked again ran until the iteration budget ended it. After four consecutive identical failures the fifth identical call is answered with a refusal that names the count and asks for a different call; a success in between resets the count, so a poll that fails a few times before it succeeds is never touched. `refuseFailedAfter` on `RepeatCallThresholds` sets the number; `repeatCallAdvisory: false` on `query` switches the tracker off entirely, as before.
