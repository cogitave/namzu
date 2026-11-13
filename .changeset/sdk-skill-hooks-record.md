---
'@namzu/sdk': minor
---

A skill's hooks can now be kept with the conversation. The `skill` tool asks its host (`SkillHooksPlan.resumable`) and writes a `skill_hooks_attached` record (new, `ignorable`, so older releases skip it and read the conversation unchanged) through `ToolContext.recordSkillHooks`; the model is told when it could not be written. New exported types: `SkillHooksRecordFact`, `SkillHooksAttachedRecord`. Nothing is required of you; a host that does not set `resumable` behaves as before.
