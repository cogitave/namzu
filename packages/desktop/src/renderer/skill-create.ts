/**
 * The ways into creating a skill from the window, and the one prompt they all start from. The
 * Skills list's "New skill" button and the composer's "/skills new" put the same request in a
 * message box; the engine's skill-creator flow takes it from there (interview, draft, a card to
 * save it). Plain values and two window events, so the wording and the wiring can be tested alone.
 */

/** The Skills list asks the window for a new conversation that starts the skill-creator flow. */
export const NEW_SKILL_EVENT = 'namzu:new-skill'

/** The saved-skill card asks the window to open Settings on the Skills list. */
export const OPEN_SKILLS_EVENT = 'namzu:open-skills'

/** A skill was saved or changed: an open Skills list reads the installed skills again. */
export const SKILLS_CHANGED_EVENT = 'namzu:skills-changed'

/** The request the person sends to start a skill; the same one the engine's own `skills new` command makes. */
export function newSkillPrompt(idea: string): string {
	const what = idea.trim()
	return [
		'Help me create a new skill. Load the skill-creator skill with the skill tool and follow it: interview me, show me the draft, and save it with save_skill only after I agree. Write the skill in the language of my own messages, not in English by default (this request is written in English; it does not count).',
		what ? `What the skill should do: ${what}` : 'Start by asking what the skill should do.',
	].join(' ')
}
