---
'@namzu/sdk': patch
---

The `schedule` tool no longer refuses a proposal that uses the `read-only` preset with web or browser access as "a shell on the host". The preset denies `bash`, but the check looked only at explicit rules and `unmatched`, so `{ preset: 'read-only', unmatched: 'park', browser: … }` was refused. A proposal with `edit-in-folder`, or with a `bash` rule that is not `deny`, is still refused.
