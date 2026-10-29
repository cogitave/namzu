---
'@namzu/cli': patch
---

The skill list and the instructions a tool server supplies (`instructions: true`) are now sent to the model as hidden reminders: in full the first time, and afterwards only the skills or servers that are new or changed. They no longer sit in the system prompt or in every request, so a skill added during a session does not change the cached prefix. A skill's location is no longer listed; the model loads a skill by name through the `skill` tool. Nothing to change to keep working.
