---
"@namzu/cli": patch
---

Show one named status row for every observed agent completion, including tasks the model never explicitly waits on. Label active waits with the task name and avoid repeating successful wait protocol payloads in the main transcript. Agent reports remain available through Ctrl+T; unknown waits and tool errors stay visible.
