import type { ThreadState } from '../shared/projection.js'
import { palToolActivity } from './pal-activity.js'

export interface PalRecentAction {
	id: string
	title: string
	detail: string
	status: 'working' | 'done' | 'failed' | 'stopped'
	category: 'message' | 'pals' | 'file' | 'computer' | 'other'
}

const actions: Record<
	string,
	{ title: string; category: PalRecentAction['category']; done?: string }
> = {
	send_pal_message: { title: 'Message to another Pal', category: 'message', done: 'Sent to inbox' },
	list_pals: { title: 'Available Pals', category: 'pals', done: 'Checked' },
	read_pal_messages: { title: 'Pal inbox', category: 'message', done: 'Checked' },
	task_create: { title: 'Add a plan step', category: 'other' },
	task_update: { title: 'Update the plan', category: 'other' },
	task_list: { title: 'Check the plan', category: 'other' },
	read: { title: 'Read a file', category: 'file' },
	write: { title: 'Write a file', category: 'file' },
	edit: { title: 'Edit a file', category: 'file' },
	glob: { title: 'Find files', category: 'file' },
	grep: { title: 'Search files', category: 'file' },
	bash: { title: 'Run a command', category: 'computer' },
}
const planningTools = new Set(['task_create', 'task_update', 'task_list'])

/** Safe intent labels, never reconstructed from arguments, output or private receipts. */
export function palRecentActivity(thread: ThreadState): PalRecentAction[] {
	return palToolActivity(thread)
		.filter(({ tool }) => !(planningTools.has(tool.title) && tool.status === 'completed'))
		.reverse()
		.slice(0, 5)
		.map(({ id, tool }) => {
			const action: (typeof actions)[string] = Object.hasOwn(actions, tool.title)
				? actions[tool.title]
				: {
						title:
							tool.view.kind === 'terminal'
								? 'Run a command'
								: tool.view.kind === 'diff'
									? 'Edit a file'
									: 'Other action',
						category:
							tool.view.kind === 'terminal'
								? 'computer'
								: tool.view.kind === 'diff'
									? 'file'
									: 'other',
					}
			const status =
				tool.status === 'completed'
					? 'done'
					: tool.status === 'failed'
						? 'failed'
						: thread.activeToolIds.includes(id)
							? 'working'
							: 'stopped'
			return {
				id,
				title: action.title,
				category: action.category,
				status,
				detail:
					status === 'working'
						? 'In progress'
						: status === 'failed'
							? 'Couldn’t finish'
							: status === 'stopped'
								? 'Stopped'
								: (action.done ?? 'Done'),
			}
		})
}
