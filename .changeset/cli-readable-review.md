---
"@namzu/cli": patch
---

The permission dialog opens readable for any batch it can show completely. A `read`, `grep`, `glob`, `ls` or connected-server call has no formatter and used to drop the whole batch into the exact JSON view, so an edit beside a read was reviewed as raw JSON by default; such a call is now listed key by key with every value JSON-escaped, which hides nothing, and the exact view stays one `d` away. An evolved shape of a tool that does have a formatter (`bash`, `edit`, `write`, `Agent`) and a tool whose name is not a plain token still open exact-first.
