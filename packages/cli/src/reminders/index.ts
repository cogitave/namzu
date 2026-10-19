import { existsSync } from 'node:fs'

import type { ReminderSource, Task } from '@namzu/sdk'

import type { PermissionMode } from '../permissions/mode.js'
import { planModeReminders } from './plan-mode.js'
import { taskNudge } from './task-nudge.js'

export { frameReminder, reminderKindOf } from './frame.js'
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
	/** Whether the plan file exists; defaults to the filesystem. */
	readonly planExists?: (path: string) => boolean
}

/**
 * The reminders this terminal feeds a turn: plan mode's, then the task nudge.
 * Both read the conversation they are handed, so there is nothing to carry
 * between requests.
 */
export function createCliReminderSource(options: CliReminderOptions): ReminderSource {
	return async ({ messages }) => {
		const out: string[] = []
		if (options.planPath) {
			const planPath = options.planPath()
			out.push(
				...planModeReminders({
					messages,
					mode: options.mode(),
					planPath,
					planExists: (options.planExists ?? existsSync)(planPath),
					canAsk: options.canAsk === true,
				}),
			)
		}
		if (options.tasks) {
			// Counted before the read: no list is fetched on the many requests that owe no nudge.
			const nudge = taskNudge(messages, [])
			if (nudge.length > 0) out.push(...taskNudge(messages, await options.tasks()))
		}
		return out
	}
}
