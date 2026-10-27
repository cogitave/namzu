import { existsSync } from 'node:fs'

import type { ReminderSource, Task } from '@namzu/sdk'

import type { EnvironmentFacts } from '../context/environment.js'
import type { PermissionMode } from '../permissions/mode.js'
import { environmentReminders } from './environment.js'
import { hypermodeReminders } from './hypermode.js'
import { modeReminders } from './mode.js'
import { planModeReminders } from './plan-mode.js'
import { taskNudge } from './task-nudge.js'

export { environmentReminders } from './environment.js'
export { modeReminders } from './mode.js'
export { frameReminder, reminderKindOf } from './frame.js'
export { HYPERMODE_REMINDER_EVERY, hypermodeExitOwed, hypermodeReminders } from './hypermode.js'
export { planModeReminders } from './plan-mode.js'
export { taskNudge } from './task-nudge.js'

export interface CliReminderOptions {
	/** The mode decisions are made under right now (read at every request). */
	readonly mode: () => PermissionMode
	/** The plan file, when this session has a plan mode; absent means no plan reminders. */
	readonly planPath?: () => string
	/** Whether the model can ask the user a question. */
	readonly canAsk?: boolean
	/** The session's tasks, when it has task tools; absent means no nudge. */
	readonly tasks?: () => Promise<readonly Pick<Task, 'id' | 'status' | 'subject'>[]>
	/** Whether hypermode is on, and whether the `workflow` tool is listed; absent means no hypermode reminders. */
	readonly hypermode?: () => { readonly on: boolean; readonly toolListed: boolean }
	/**
	 * The date and working directory as this turn read them; absent means the
	 * system prompt carries them and no environment reminder is sent.
	 */
	readonly environment?: () => Pick<EnvironmentFacts, 'today' | 'branch' | 'isRepository'>
	/** Whether a person answers permission prompts; absent means no mode announcements. */
	readonly interactive?: boolean
	/** Whether the plan file exists; defaults to the filesystem. */
	readonly planExists?: (path: string) => boolean
}

/**
 * The reminders this terminal feeds a turn: the date and mode notices, plan mode's, hypermode's, then the task nudge.
 * Both read the conversation they are handed, so there is nothing to carry
 * between requests.
 */
export function createCliReminderSource(options: CliReminderOptions): ReminderSource {
	return async ({ messages }) => {
		const out: string[] = []
		if (options.environment) {
			out.push(...environmentReminders({ messages, facts: options.environment() }))
		}
		// One mode replacing another reads ended first, then begun: plan mode's end goes
		// ahead of the mode notice, and its start after it.
		const plan: string[] = []
		if (options.planPath) {
			const planPath = options.planPath()
			plan.push(
				...planModeReminders({
					messages,
					mode: options.mode(),
					planPath,
					planExists: (options.planExists ?? existsSync)(planPath),
					canAsk: options.canAsk === true,
				}),
			)
		}
		const planEnd = plan.filter((text) => text.startsWith('<system-reminder kind="plan-exit"'))
		out.push(...planEnd)
		if (options.interactive !== undefined) {
			out.push(
				...modeReminders({ messages, mode: options.mode(), interactive: options.interactive }),
			)
		}
		out.push(...plan.filter((text) => !planEnd.includes(text)))
		if (options.hypermode) out.push(...hypermodeReminders({ messages, ...options.hypermode() }))
		if (options.tasks) {
			// Counted before the read: no list is fetched on the many requests that owe no nudge.
			const nudge = taskNudge(messages, [])
			if (nudge.length > 0) out.push(...taskNudge(messages, await options.tasks()))
		}
		return out
	}
}
