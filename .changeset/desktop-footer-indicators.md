---
'@namzu/desktop': patch
'@namzu/cli': patch
---

The message box in Namzu Desktop now shows, beside the mode, how many background shells are running ("2 shells", which opens the list) and the pull request of the conversation's branch ("PR #607", coloured by review state, which opens it in the browser). The pull request comes from the GitHub command line tool the terminal already uses; with `gh` missing, signed out, or no pull request, nothing is shown. The CLI host gains a read-only `namzu/project/pr` request for it.
