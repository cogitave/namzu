---
'@namzu/sdk': patch
---

`combineToolsets` now releases earlier live-toolset listeners if a later source fails to subscribe. Its unsubscribe also attempts every inner cleanup when one throws, so failed setup and teardown do not leave other sources observing a finished manager.
