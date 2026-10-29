import type { Message } from '@namzu/sdk'
import { frameReminder, reminderKindOf } from './frame.js'

/** Exact runtime selection, not a model family inferred from an alias. */
export interface ModelReminderFacts {
	readonly provider: string
	readonly model: string
}

/** The catalogue does not publish a knowledge cutoff. Never derive one from an ID. */
export function modelReminders(messages: readonly Message[], facts: ModelReminderFacts): string[] {
	const text = frameReminder(
		'model',
		`Requested runtime model: ${JSON.stringify(facts.model)} on provider ${JSON.stringify(facts.provider)}.\nThis identifies the selected route for this turn, not a change to your Namzu identity. A fallback notice, if any, identifies a later route.\nThe available model metadata does not establish a knowledge cutoff. Do not invent one or infer one from the model name.`,
	)
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as Message
		if (reminderKindOf(message) === 'model') return message.content === text ? [] : [text]
	}
	return [text]
}
