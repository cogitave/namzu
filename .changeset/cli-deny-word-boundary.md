---
'@namzu/cli': patch
---

A deny rule for a command (for example bash 'gh *' or 'rm *') now matches where that command starts, anywhere in the line, and no longer matches the same letters inside another word: 'gh *' denies 'gh pr list' and 'x && gh api', not 'through' or 'ghost'. A rule that starts with '*' still matches anywhere.
