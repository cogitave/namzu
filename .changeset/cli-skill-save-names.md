---
'@namzu/cli': patch
---

The skill save screen and the skill list use plain labels. The terminal screen offers "Save skill" (your user skills), "Save to project" and "Cancel"; `/skills list` and `namzu skills list` show where a skill lives as `user`, `user, shared`, `project`, `project, shared`, `project, legacy` or `built-in` instead of a folder (JSON output keeps `tier` and `path`); an empty list says "No skills yet. Create skills in .namzu/skills/ or ~/.namzu/skills/." Scripts that match the old text should match the new words. `save_skill` now writes through the SDK's shared atomic write and still refuses symbolic links.
