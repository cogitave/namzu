import { existsSync } from 'node:fs'

import type { ReminderSource } from '@namzu/sdk'

import type { PermissionMode } from '../permissions/mode.js'
import { planModeReminders } from './plan-mode.js'

export { frameReminder, reminderKindOf } from './frame.js'
export { planModeReminders } from './plan-mode.js'

export interface CliReminderOptions {
	/** The mode decisions are made under right now (read at every request). */
	readonly mode: () => PermissionMode
	/** The plan file, when this session has a plan mode; absent means no plan reminders. */
	readonly planPath?: () => string
	/** Whether the model can ask the user a question. */
	readonly canAsk?: boolean
	/** Whether the plan file exists; defaults to the filesystem. */
	readonly planExists?: (path: string) => boolean
}

/**
 * The reminders this terminal feeds a turn. They read the conversation they
 * are handed, so there is nothing to carry between requests.
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
		return out
	}
}
