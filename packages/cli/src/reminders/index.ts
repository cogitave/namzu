import { existsSync } from 'node:fs'

import type { ReminderSource, Task } from '@namzu/sdk'

import type { EnvironmentFacts } from '../context/environment.js'
import type { PermissionMode } from '../permissions/mode.js'
import { type ChangedFilesInput, changedFileReminders } from './changed-files.js'
import { environmentReminders } from './environment.js'
import { hypermodeReminders } from './hypermode.js'
import { type McpInstructionsInput, mcpInstructionsReminders } from './mcp-instructions.js'
import { type MemoryIndexInput, memoryIndexReminders } from './memory-index.js'
import { modeReminders } from './mode.js'
import { type ModelReminderFacts, modelReminders } from './model.js'
import { planModeReminders } from './plan-mode.js'
import { type SkillListingInput, skillListingReminders } from './skills.js'
import { taskNudge } from './task-nudge.js'

export { changedFileReminders } from './changed-files.js'
export { environmentReminders } from './environment.js'
export { modeReminders } from './mode.js'
export { frameReminder, reminderKindOf } from './frame.js'
export { HYPERMODE_REMINDER_EVERY, hypermodeExitOwed, hypermodeReminders } from './hypermode.js'
export { planModeReminders } from './plan-mode.js'
export { skillListingReminders } from './skills.js'
export { memoryIndexReminders } from './memory-index.js'
export { mcpInstructionsReminders } from './mcp-instructions.js'
export { taskNudge } from './task-nudge.js'

export interface CliReminderOptions {
	/** The exact model selected for this turn; no inferred catalogue dates. */
	readonly model?: () => ModelReminderFacts
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
	/**
	 * The skills the model may use and the instructions its tool servers supplied,
	 * as of this request; absent means the system prompt carries them. Each is
	 * said when the conversation has not heard it, and again only for what changed.
	 */
	readonly skills?: () => Pick<SkillListingInput, 'described' | 'nameOnly'>
	readonly mcpInstructions?: () => Pick<McpInstructionsInput, 'servers' | 'frame'>
	/**
	 * The curated memory files and the stored-memory index as of this request;
	 * absent means the request carries them itself. Said in full when the
	 * conversation has not heard them, and again only for the parts that changed.
	 */
	readonly memory?: () => MemoryIndexInput['sections']
	/**
	 * The ledger of files this session read and the directory their paths are shown
	 * against; absent means no changed-on-disk notices. A file the model read whole
	 * and that someone else changed since is said once, with what changed.
	 */
	readonly changedFiles?: () => Promise<ChangedFilesInput>
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
		if (options.model) out.push(...modelReminders(messages, options.model()))
		if (options.environment) {
			out.push(...environmentReminders({ messages, facts: options.environment() }))
		}
		if (options.memory) out.push(...memoryIndexReminders({ messages, sections: options.memory() }))
		if (options.changedFiles)
			out.push(...(await changedFileReminders(await options.changedFiles())))
		if (options.skills) out.push(...skillListingReminders({ messages, ...options.skills() }))
		if (options.mcpInstructions) {
			out.push(...mcpInstructionsReminders({ messages, ...options.mcpInstructions() }))
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
