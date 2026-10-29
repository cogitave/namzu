---
"@namzu/cli": patch
---

Apply a file permission pattern ending in `/**` to the directory itself as well as its descendants. A narrower same-layer allowance such as `src/public/**` now permits discovery rooted at `src/public`; broader denied roots and searches above restricted descendants remain refused.
