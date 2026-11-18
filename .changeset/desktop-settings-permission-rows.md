---
'@namzu/desktop': patch
---

Settings, Projects and Tools: the permission rules, the permission self-checks and the browser sites are lists you add to and remove from, instead of JSON boxes. The rules list changes only the rules, so the permission mode, the two switches that close bypass and auto mode, the outside-folder choice and the auto mode reviewer are never touched, and Use default now clears only the rules (it used to clear those too). Each asks first only when a change lets more run without asking you, and says which: an allow rule added or loosened, a deny or ask rule removed, a check removed, a site that becomes Act or stops being denied. The self-check and site examples are valid ones now.
