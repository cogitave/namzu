---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Tool review prompts now carry the originating run ID. The CLI uses this identity to show which agent requested an approval, retaining the attribution as concurrent requests advance through the queue. Unrecognized runs display their ID instead of an inferred agent name.
