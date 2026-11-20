---
'@namzu/cli': patch
---

A file that a shell command only read (`cat`, `grep`, `git diff`) is no longer taken for one the session wrote, so an edit made in an editor during the same step is reported; a file name now has to match as a whole path token, so a file called `go` is not named by `go test`. The context inventory uses the SDK's one rule for shed content.
