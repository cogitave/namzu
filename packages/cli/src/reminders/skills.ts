import { type Message, type Skill, isInvocableBy } from '@namzu/sdk'

import { frameReminder, reminderKindOf } from './frame.js'

/**
 * Which skills the model has been told about, turn by turn.
 *
 * The list used to sit in the cached system prompt, so a skill written or
 * removed mid-session re-keyed the whole prefix. It rides here instead: the
 * whole list the first time the conversation hears it, and afterwards only the
 * skills that are new or whose line changed, plus withdrawals for removed
 * skills. The conversation is the record,
 * so a resumed or compacted conversation needs no counter of its own: a
 * compaction that drops the reminders makes the next request say the list
 * again, in full.
 */
export interface SkillListingInput {
	readonly messages: readonly Message[]
	/** The skills the model may invoke, with the room the budget gave their descriptions. */
	readonly described: readonly Skill[]
	/** Skills the budget left without room for a description; they are named only. */
	readonly nameOnly: readonly string[]
}

/** A description is cut here so one skill cannot take the room of many. */
export const SKILL_LISTING_DESCRIPTION_MAX_CHARS = 1536

const FIRST =
	'These skills are available through the skill tool. When the task matches one, load it by name and follow it. A skill is guidance, not an extra tool: permissions are unchanged.'

const NAME_ONLY =
	'An entry with no description is one whose description did not fit; call the skill tool without a name to list them with descriptions.'

const CHANGED =
	'These skills are new, or their descriptions changed, since the list you were given:'

const WITHDRAWN = 'These skills are no longer available through the skill tool:'

const ENTRY = /^- ([^\s:]+)(?:: .*)?$/
const WITHDRAWAL = /^- ([^\s:]+) \(withdrawn\)$/

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim()
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The listing line for one skill; also the value a later request compares against. */
export function skillListingLine(skill: Skill): string {
	const description = oneLine(skill.metadata.description, SKILL_LISTING_DESCRIPTION_MAX_CHARS)
	return description.length > 0
		? `- ${skill.metadata.name}: ${description}`
		: `- ${skill.metadata.name}`
}

/** Replay the surviving announcements, including withdrawals, in conversation order. */
function announced(messages: readonly Message[]): Map<string, string> {
	const told = new Map<string, string>()
	for (const message of messages) {
		if (reminderKindOf(message) !== 'skill-listing' || typeof message.content !== 'string') continue
		for (const line of message.content.split('\n')) {
			const withdrawn = WITHDRAWAL.exec(line)?.[1]
			if (withdrawn !== undefined) {
				told.delete(withdrawn)
				continue
			}
			const name = ENTRY.exec(line)?.[1]
			if (name !== undefined) told.set(name, line)
		}
	}
	return told
}

/** The reminders to append before the next request; empty when the list is already known. */
export function skillListingReminders(input: SkillListingInput): string[] {
	const entries = new Map<string, string>()
	for (const skill of input.described) {
		if (isInvocableBy(skill, 'model')) entries.set(skill.metadata.name, skillListingLine(skill))
	}
	for (const name of input.nameOnly) {
		if (!entries.has(name)) entries.set(name, `- ${name}`)
	}
	const told = announced(input.messages)
	const removed = [...told.keys()].filter((name) => !entries.has(name))
	const owed = [...entries]
		.filter(([name, line]) => told.get(name) !== line)
		.map(([, line]) => line)
	if (owed.length === 0 && removed.length === 0) return []

	const first = told.size === 0
	const head = first
		? owed.some((line) => !line.includes(': '))
			? `${FIRST}\n${NAME_ONLY}`
			: FIRST
		: CHANGED
	const sections: string[] = []
	if (owed.length > 0) sections.push(`${head}\n${owed.join('\n')}`)
	if (removed.length > 0) {
		sections.push(`${WITHDRAWN}\n${removed.map((name) => `- ${name} (withdrawn)`).join('\n')}`)
	}
	return [frameReminder('skill-listing', sections.join('\n\n'))]
}
