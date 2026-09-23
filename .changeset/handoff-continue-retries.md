---
'@namzu/cli': patch
---

Continuing a turn a tool paused for a person — Enter at "The browser needs you", or Continue on a parked scheduled run — now tells the model that you dealt with it and to try the step again. It used to see only the tool's "needs a person" result and end the turn, so a scheduled post you had signed in again for was reported as not possible. The Continue/Abandon card for a scheduled run names the site, the profile and the sign-in command in words.
