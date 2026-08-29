---
'@namzu/sdk': patch
---

Confine the Git workspace driver to its configured repository and managed worktree root. Persisted foreign paths, static symlink escapes, and mismatched branch metadata now fail before destructive Git operations; option-shaped base refs are passed as refs, and already-gone disposal is established from the repository registry rather than stderr wording.
