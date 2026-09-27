---
'@namzu/cli': patch
---

Keep the composer ready for the first keystroke after a text prompt closes. The previously hidden composer could briefly lose that keystroke while its input listener was being reattached.
