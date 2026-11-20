---
'@namzu/sdk': patch
---

A shell command run by a session with a scratch folder now gets `NAMZU_SCRATCH`, a short link (`<private temp root>/s-<8 hex>`) to that folder, so a command need not type the long encoded path. The real folder and its path are unchanged; a value the host puts in `turnConfig.env` wins.
