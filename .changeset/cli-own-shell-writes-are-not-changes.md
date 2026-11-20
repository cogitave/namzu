---
'@namzu/cli': patch
---

A file that the session's own shell command wrote (a heredoc, `sed -i`, a script that names it) is no longer reported back as "changed on disk", and the same changed body is not reported twice when only its modification time moves.
