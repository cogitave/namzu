import type { Message } from '@namzu/sdk'

import { type ReminderKind, frameReminder, isOperatorTurn, reminderKindOf } from './frame.js'

/**
 * What the model is told about the standing hypermode, turn by turn.
 *
 * - on, and the last thing said was not "on": the full text;
 * - on, said, and {@link HYPERMODE_REMINDER_EVERY} operator messages have
 *   passed since: the sparse text;
 * - off, and the last thing said was "on": the exit text, once.
 *
 * Like the plan-mode reminders, the count runs over the conversation: what was
 * said is the reminders already in it. A resumed conversation therefore does
 * not hear the full text again, and one whose history was compacted away
 * hears it once more.
 */
export const HYPERMODE_REMINDER_EVERY = 10

const FULL_WITH_TOOL =
	'Hypermode is on: optimize for the most exhaustive, correct answer, not the fastest or cheapest. Use the `workflow` tool on every substantive task; token cost is not a constraint. Pick from the quality patterns in the tool description (adversarial verify, judge panel, loop until dry, completeness critic). Solo only on conversational or trivial turns.'

const FULL_WITHOUT_TOOL =
	'Hypermode is on: optimize for the most exhaustive, correct answer, not the fastest or cheapest. The `workflow` tool is not available in this run, so delegate every substantive task to parallel agents with the `Agent` tool and have their findings verified; token cost is not a constraint. Solo only on conversational or trivial turns.'

const SPARSE_WITH_TOOL = 'Hypermode is still on: use the `workflow` tool for substantive work.'

const SPARSE_WITHOUT_TOOL =
	'Hypermode is still on: delegate substantive work to parallel agents with the `Agent` tool.'

const EXIT = "Hypermode is off: the `workflow` tool's standard opt-in rule applies again."

export interface HypermodeReminderInput {
	readonly messages: readonly Message[]
	/** Whether hypermode is on for the request about to be made. */
	readonly on: boolean
	/** Whether the `workflow` tool is in this request's tool list. */
	readonly toolListed: boolean
}

/** Operator messages since the latest hypermode reminder, and which kind that was. */
function scan(messages: readonly Message[]): {
	readonly last: Extract<ReminderKind, 'hypermode-on' | 'hypermode-exit'> | undefined
	readonly turns: number
} {
	let turns = 0
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as Message
		const kind = reminderKindOf(message)
		if (kind === 'hypermode-on' || kind === 'hypermode-exit') return { last: kind, turns }
		if (isOperatorTurn(message)) turns++
	}
	return { last: undefined, turns }
}

/**
 * Whether the latest thing said about hypermode in this conversation was
 * "on", so the exit text is still owed when the mode is off now. A host
 * that does not otherwise feed reminders uses it to make a source anyway.
 */
export function hypermodeExitOwed(messages: readonly Message[]): boolean {
	return scan(messages).last === 'hypermode-on'
}

/** The reminders to append before the next request; empty when there is nothing to say. */
export function hypermodeReminders(input: HypermodeReminderInput): string[] {
	const { last, turns } = scan(input.messages)
	if (!input.on) {
		return last === 'hypermode-on' ? [frameReminder('hypermode-exit', EXIT)] : []
	}
	if (last !== 'hypermode-on') {
		return [
			frameReminder('hypermode-on', input.toolListed ? FULL_WITH_TOOL : FULL_WITHOUT_TOOL, 'full'),
		]
	}
	if (turns < HYPERMODE_REMINDER_EVERY) return []
	return [
		frameReminder(
			'hypermode-on',
			input.toolListed ? SPARSE_WITH_TOOL : SPARSE_WITHOUT_TOOL,
			'sparse',
		),
	]
}
