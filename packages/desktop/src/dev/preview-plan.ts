import type { AcpTask, ToolCallView } from '@namzu/sdk'
import type { HistoryWorkSnapshot } from '../shared/history-work.js'
import type { ChatMessage, DesktopEvent } from '../shared/protocol.js'

// Plan rows: /preview?plan=1 restores two saved turns that touched the plan, /preview?plan=1&live=1
// plays a turn that adds three tasks and works through them. Nothing here runs otherwise.
const call = (label: string): ToolCallView => ({ kind: 'generic', label, presentation: 'activity' })
const task = (taskId: string, subject: string, status: AcpTask['status']): AcpTask => ({
	taskId,
	subject,
	status,
	blockedBy: [],
})

const savedStart = Date.UTC(2026, 9, 8, 9, 0, 0)
interface SavedTurn {
	id: string
	prompt: string
	tools: { id: string; name: string; label: string }[]
	answer: string
}
const savedTurns: SavedTurn[] = [
	{
		id: 'p1',
		prompt: 'Plan the sidebar clean-up.',
		tools: [
			{ id: 'p1-a', name: 'task_create', label: 'Add task · Read the styles' },
			{ id: 'p1-b', name: 'task_create', label: 'Add task · Fix the spacing' },
		],
		answer: 'I wrote down two steps.',
	},
	{
		id: 'p2',
		prompt: 'Now do them, and check the rest.',
		tools: [
			{ id: 'p2-a', name: 'task_create', label: 'Add task · Run the tests' },
			{ id: 'p2-b', name: 'task_update', label: 'Update task · Fix the spacing' },
			{ id: 'p2-c', name: 'bash', label: 'pnpm test' },
		],
		answer: 'Two steps are done; the tests still need a run.',
	},
]
const savedTasks = (finished: boolean): AcpTask[] => [
	task('t1', 'Read the styles', 'completed'),
	task('t2', 'Fix the spacing', 'completed'),
	task('t3', 'Run the tests', finished ? 'completed' : 'pending'),
]

export function planMessages(): ChatMessage[] {
	return savedTurns.flatMap((turn, index): ChatMessage[] => {
		const at = (offset: number): ChatMessage['time'] => ({
			at: savedStart + index * 600_000 + offset,
			source: 'journal',
		})
		return [
			{ role: 'user', text: turn.prompt, time: at(0) },
			{
				role: 'assistant',
				text: 'Starting.',
				phase: 'commentary',
				time: at(1000),
			},
			{ role: 'assistant', text: turn.answer, status: 'completed', time: at(20000) },
		]
	})
}

export function planWork(): HistoryWorkSnapshot {
	const work: HistoryWorkSnapshot = { v: 1, partial: false, messages: [], turns: [], tools: [] }
	let order = 1
	let index = 0
	for (const turn of savedTurns) {
		work.turns.push({
			turnId: turn.id,
			userMessageId: `${turn.id}-u`,
			order: order++,
			status: 'completed',
			reason: 'end_turn',
			durationMs: 20000,
		})
		work.messages.push({
			index: index++,
			messageId: `${turn.id}-u`,
			turnId: turn.id,
			order: order++,
		})
		work.messages.push({
			index: index++,
			messageId: `${turn.id}-s`,
			turnId: turn.id,
			order: order++,
		})
		for (const tool of turn.tools)
			work.tools.push({
				turnId: turn.id,
				toolUseId: tool.id,
				name: tool.name,
				order: order++,
				status: 'completed',
				presentation: call(tool.label),
			})
		work.messages.push({
			index: index++,
			messageId: `${turn.id}-a`,
			turnId: turn.id,
			order: order++,
		})
	}
	return work
}

export const planSavedTasks = savedTasks

interface Step {
	name: string
	after: number
	update?: Extract<DesktopEvent, { kind: 'update' }>['update']
	task?: AcpTask
}

/** A running turn that adds three tasks, then moves through them one at a time. */
export function planSteps(): Step[] {
	const tool = (id: string, title: string, label: string, status: 'pending' | 'completed') => ({
		kind: 'tool_call' as const,
		toolCallId: id,
		title,
		status,
		view: call(label),
	})
	const subjects = ['Read the styles', 'Fix the spacing', 'Run the tests']
	const steps: Step[] = [
		{
			name: 'say',
			after: 300,
			update: {
				kind: 'agent_message_chunk',
				text: 'I will plan three steps first.',
				phase: 'commentary',
				messageId: 'plan-say',
			},
		},
	]
	subjects.forEach((subject, index) => {
		const id = `plan-c${index}`
		steps.push({
			name: `create-${index}`,
			after: 500,
			update: tool(id, 'task_create', `Add task · ${subject}`, 'pending'),
		})
		steps.push({
			name: `created-${index}`,
			after: 300,
			update: tool(id, 'task_create', `Add task · ${subject}`, 'completed'),
			task: task(`t${index + 1}`, subject, 'pending'),
		})
	})
	subjects.forEach((subject, index) => {
		const id = `t${index + 1}`
		steps.push({
			name: `start-${index}`,
			after: 800,
			update: tool(`plan-u${index}`, 'task_update', `Update task · ${subject}`, 'completed'),
			task: task(id, subject, 'in_progress'),
		})
		steps.push({
			name: `work-${index}`,
			after: 2500,
			update: {
				kind: 'tool_call',
				toolCallId: `plan-w${index}`,
				title: 'bash',
				status: 'completed',
				view: { kind: 'terminal', command: `pnpm step-${index + 1}`, output: 'ok' },
			},
		})
		steps.push({
			name: `done-${index}`,
			after: 800,
			update: tool(`plan-d${index}`, 'task_update', `Update task · ${subject}`, 'completed'),
			task: task(id, subject, 'completed'),
		})
	})
	steps.push({
		name: 'answer',
		after: 400,
		update: {
			kind: 'agent_message_chunk',
			text: 'All three steps are done.',
			messageId: 'plan-answer',
		},
	})
	return steps
}
