---
'@namzu/sdk': minor
---

Adds `SkillMetadata.listing`. A host that sets `listing: 'name-only'` on a skill it hands to the prompt gets a manifest entry with the name and location and no description, so the skill costs a few tokens a turn and the model can still load it by name. Absent keeps the whole entry; nothing changes for a host that does not set it.
