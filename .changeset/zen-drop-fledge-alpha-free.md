---
"@namzu/zen": major
---

**Breaking: `fledge-alpha-free` leaves the bundled catalogue.** Zen no longer documents or serves it, so `findZenModel('zen', 'fledge-alpha-free')` and `getZenModels('zen')` no longer return it, and a request naming it fails as an unknown model. Pick another free Zen model, for example `step-5-preview-free` or `mimo-v2.6-flash-free`.
