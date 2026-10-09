---
"@namzu/cli": patch
---

An approval request for a write that would leave the file exactly as it is now carries a file preview with `before` equal to `after`, where it carried none. A client that treated a missing preview as "cannot show the file" can now say "no change". A client that draws `before` and `after` as a diff shows an empty diff.
