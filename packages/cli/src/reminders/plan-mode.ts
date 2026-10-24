import type { Message } from '@namzu/sdk'

import { type ReminderKind, frameReminder, isOperatorTurn, reminderKindOf } from './frame.js'

/**
 * Plan-mode reminders: a reminder
 * is sent when plan mode is on and none has been sent in the last 5 operator
 * turns; the first of a stretch is the full text, and so is every 5th after it
 * (1st, 6th, 11th …); the ones between are one short line. Leaving plan mode
 * sends a single note, once.
 *
 * "Turn" here is an operator message, not a model request: inside one long
 * reply the mode is restated only the moment it is first seen, so a reply that
 * calls fifty tools does not repeat itself fifty times.
 */
export const PLAN_REMINDER_EVERY_N_TURNS = 5
export const PLAN_REMINDER_FULL_EVERY_N = 5

export interface PlanModeReminderInput {
	readonly messages: readonly Message[]
	readonly mode: string
	readonly planPath: string
	readonly planExists: boolean
	/** Whether the model has a way to ask the user a question. */
	readonly canAsk: boolean
}

interface Stretch {
	/** Operator messages since the latest plan-mode reminder (all of them if none). */
	readonly turnsSinceReminder: number
	/** Whether this plan-mode stretch has a reminder at all. */
	readonly hasReminder: boolean
	/** Plan-mode reminders sent since plan mode was last left. */
	readonly sent: number
	/** Whether plan mode was ever left earlier in this conversation. */
	readonly hasExited: boolean
}

function scan(messages: readonly Message[]): Stretch {
	let turns = 0
	let hasReminder = false
	let sent = 0
	let hasExited = false
	let inStretch = true
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as Message
		const kind: ReminderKind | undefined = reminderKindOf(message)
		if (kind === 'plan-exit') {
			hasExited = true
			if (!hasReminder) inStretch = false
			break
		}
		if (kind === 'plan-mode' || kind === 'plan-reentry') {
			if (inStretch) hasReminder = true
			if (kind === 'plan-mode') sent++
			continue
		}
		if (!hasReminder && isOperatorTurn(message)) turns++
	}
	return { turnsSinceReminder: turns, hasReminder, sent, hasExited }
}

function fullText(input: PlanModeReminderInput): string {
	const file = input.planExists
		? `A plan already exists at ${input.planPath}. Read it, then revise it in place with the edit tool.`
		: `No plan exists yet. Create it at ${input.planPath} with the write tool.`
	const ending = input.canAsk
		? 'Your turn ends in exactly one of two ways: you ask the user a question with ask_user_question to settle something you cannot decide yourself, or you call exit_plan_mode once the plan file is ready for approval.'
		: 'Your turn ends by calling exit_plan_mode once the plan file is ready for approval.'
	return `Plan mode is on. Change nothing except the plan file: no edits, no commands that change state, no commits. This overrides every other instruction you have.

${file} It is the only file you may write; build the plan up in it as you learn.

How to plan:
1. Understand the request. Read the code it touches and look for existing functions and patterns to reuse before proposing new ones. For wide questions, send read-only explore agents; one is usually enough.
2. Decide on one approach. Weigh alternatives briefly and keep only the one you recommend.
3. Write the plan file: why the change is needed, the recommended approach, the files to change, what existing code it reuses, and how to verify the result end to end.
4. Finish. ${ending} Never ask for approval in plain text ("does this look right?"); exit_plan_mode is how the user is asked.`
}

function sparseText(input: PlanModeReminderInput): string {
	return `Plan mode is still on (full rules above). Only ${input.planPath} may be written. End the turn by ${input.canAsk ? 'asking the user a question or ' : ''}calling exit_plan_mode.`
}

function reentryText(input: PlanModeReminderInput): string {
	return `You are back in plan mode after leaving it earlier. A plan from that session is at ${input.planPath}. Before planning anything new, read it and compare it with the current request: if this is a different task, start over and overwrite it; if it continues the same task, revise it and drop what no longer applies. Edit the plan file one way or the other before you call exit_plan_mode.`
}

function exitText(input: Pick<PlanModeReminderInput, 'planPath' | 'planExists'>): string {
	return `You have left plan mode. You can edit files and run tools again.${input.planExists ? ` The plan is at ${input.planPath} if you need to refer to it.` : ''}`
}

/** The reminders to append before the next request; empty when there is nothing to say. */
export function planModeReminders(input: PlanModeReminderInput): string[] {
	const stretch = scan(input.messages)
	if (input.mode !== 'plan') {
		// Plan mode was on and has been left since the last time we spoke of it.
		return stretch.hasReminder ? [frameReminder('plan-exit', exitText(input))] : []
	}
	if (stretch.hasReminder && stretch.turnsSinceReminder < PLAN_REMINDER_EVERY_N_TURNS) return []
	const full = (stretch.sent + 1) % PLAN_REMINDER_FULL_EVERY_N === 1
	const out = [
		frameReminder(
			'plan-mode',
			full ? fullText(input) : sparseText(input),
			full ? 'full' : 'sparse',
		),
	]
	if (!stretch.hasReminder && stretch.hasExited && input.planExists) {
		out.push(frameReminder('plan-reentry', reentryText(input)))
	}
	return out
}
