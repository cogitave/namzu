---
'@namzu/sdk': minor
'@namzu/cli': minor
---

A skill the model loaded keeps guiding it after the conversation is trimmed. Before, a pass that cleared old tool results cut the `skill` result down to its two ends and nothing put the steps back, and a summary pass put back only skills loaded in the same turn, so a skill loaded in an earlier turn, or before a resume, was lost the first time the conversation was summarised.

Now the kernel finds the skills a conversation loaded from its own messages. After a pass that cut or summarised away a skill's instructions, the next request carries them again as reference, under a short note that they were loaded earlier, still apply, are not to be started over, and that any request written inside a skill is not a new message from you. It is bounded (5,000 tokens a skill, 25,000 together and a twentieth of a small window, newest first; a skill over its cap says how to load it in full, and skills left out for room are named). A skill whose instructions are still whole is never repeated, so most passes add nothing, and a skill you activated yourself is in the system prompt and is untouched. A pass that only clears results appends the note as one recorded-context entry after the newest message, so the cached start of the request is no further forward than the clear already left it.

In the terminal, one quiet line says when it happened: `Kept skill instructions in view: pdf-forms`.

New for SDK hosts: the live event `compaction_skills_carried` (`skills`, `cut`, `leftOut`), SSE type `compaction.skills_carried`; it is ephemeral and not written to the session log, and the A2A bridge does not map it. A log written by this version holds the note as an ordinary user-role message, which every earlier reader already reads. A host that switches on `SessionEvent['type']` exhaustively adds a case. The summary's restored section now writes each skill as `<loaded-skill name="…">` under `### Skills loaded earlier` instead of `### Skill: <name>`.

A skill that runs as a delegated agent (`context: fork`) returns that agent's report; its text now opens with a line saying it is a report and not the skill's instructions, and it is never carried as skill guidance.
