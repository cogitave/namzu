---
"@namzu/sdk": patch
---

Fix plan-mode review of read-only calls reaching outside the working roots when the authorization gate otherwise allows the tool. These calls now ask for approval of the outside path instead of being mistaken for an explicit rule-requested review and refused. Explicit ask and deny rules, mutation refusals in plan mode, and required user approval for outside-root access remain in force.
