import type { Message } from '@namzu/sdk'

import { type EnvironmentFacts, environmentFactLines } from '../context/environment.js'
import { frameReminder, reminderKindOf } from './frame.js'

/**
 * What the model is told about the date and the working directory, turn by turn.
 *
 * The facts used to sit in the cached system prompt, so a new day or a
 * checkout re-keyed the whole prefix. They ride here instead: said once when
 * the conversation has not heard them, and again only when the date or the
 * branch is no longer what the latest reminder said. The conversation is the
 * record, so a resumed or compacted conversation needs no counter of its
 * own: a compaction that drops the reminder simply makes the next request say
 * it again.
 */
export interface EnvironmentReminderInput {
	readonly messages: readonly Message[]
	readonly facts: Pick<EnvironmentFacts, 'today' | 'branch' | 'isRepository'>
}

const FIRST =
	'These are facts about right now. Prefer them over any date or branch you would otherwise assume.'

const CHANGED =
	'The date or the working environment changed since you were last told. This needs no announcement to the user; use it where it matters.'

/** The text of the latest environment reminder in the conversation, if any. */
function lastTold(messages: readonly Message[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as Message
		if (reminderKindOf(message) === 'environment' && typeof message.content === 'string') {
			return message.content
		}
	}
	return undefined
}

/** The reminders to append before the next request; empty when the facts are already known. */
export function environmentReminders(input: EnvironmentReminderInput): string[] {
	const lines = environmentFactLines(input.facts)
	const told = lastTold(input.messages)
	if (told?.includes(lines.join('\n'))) return []
	return [
		frameReminder('environment', `${told === undefined ? FIRST : CHANGED}\n${lines.join('\n')}`),
	]
}
