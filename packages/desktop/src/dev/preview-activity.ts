import type { ToolCallView } from '@namzu/sdk'
import type { HistoryWorkSnapshot } from '../shared/history-work.js'
import type { ChatMessage, ConversationView, DesktopEvent } from '../shared/protocol.js'

// Saved and live work shaped like the reference's activity rows: narration between short action
// rows, a counted summary over a run, and a running turn with a clock. Reached only through
// /preview?activity=1 (saved turns) and /preview?live=1 (a running turn); nothing runs otherwise.
export const activityConversationId = 'sample-activity'

const command = (text: string, output: string): ToolCallView => ({
	kind: 'terminal',
	command: text,
	output,
})
const diff = (path: string, before: string, after: string): ToolCallView => ({
	kind: 'diff',
	path,
	before,
	after,
})
const explore = (label: string): ToolCallView => ({
	kind: 'generic',
	label,
	presentation: 'activity',
	activity: 'exploration',
})

type Item =
	| { say: string }
	| { answer: string }
	| { tool: string; name: string; view: ToolCallView }
interface SampleTurn {
	id: string
	prompt: string
	durationMs: number
	items: Item[]
}

const css = '.row {\n  padding: 4px;\n}\n'
const sampleTurns: SampleTurn[] = [
	{
		// The finished turn of the reference: narration, two commands, a created file, the answer.
		id: 'a1',
		prompt: 'Try adding a test line to an empty file.',
		durationMs: 42000,
		items: [
			{ say: 'I found the first empty file and will add a short test line to it.' },
			{
				tool: 'a1-c1',
				name: 'bash',
				view: command('ls -la notes', 'total 0\n-rw-r--r-- 1 user user 0 empty.txt'),
			},
			{ tool: 'a1-c2', name: 'bash', view: command('wc -c notes/empty.txt', '0 notes/empty.txt') },
			{
				tool: 'a1-w',
				name: 'write',
				view: diff('/sample/app/notes/empty.txt', '', 'A short test line.\n'),
			},
			{ answer: 'I added the test line to `notes/empty.txt`.' },
		],
	},
	{
		// Six actions: a finished run this long folds to its summary row.
		id: 'a2',
		prompt: 'Tidy the sidebar styles and check nothing else uses them.',
		durationMs: 197000,
		items: [
			{ say: 'Reading the sidebar styles and looking for other users of the class first.' },
			{ tool: 'a2-r', name: 'read', view: explore('Read src/sidebar.css') },
			{ tool: 'a2-g', name: 'grep', view: explore('Search .row in src') },
			{
				tool: 'a2-c1',
				name: 'bash',
				view: command('pnpm exec biome check src/sidebar.css', 'Checked 1 file. No fixes needed.'),
			},
			{
				tool: 'a2-e1',
				name: 'edit',
				view: diff('src/sidebar.css', css, '.row {\n  padding: 6px;\n}\n'),
			},
			{ tool: 'a2-w', name: 'write', view: diff('src/rail.css', '', '.rail {\n  gap: 4px;\n}\n') },
			{ tool: 'a2-c2', name: 'bash', view: command('pnpm test', 'Tests 12 passed (12)') },
			{ answer: 'The sidebar rows use the new spacing and nothing else shares the class.' },
		],
	},
	{
		// One action is just its row.
		id: 'a3',
		prompt: 'Make the rows a little roomier.',
		durationMs: 10000,
		items: [
			{ say: 'Updating the row padding.' },
			{
				tool: 'a3-e',
				name: 'edit',
				view: diff(
					'src/sidebar.css',
					'.row {\n  padding: 6px;\n}\n',
					'.row {\n  padding: 8px;\n}\n',
				),
			},
			{ answer: 'Updated `src/sidebar.css`.' },
		],
	},
	{
		// A path the tool named in full, and one it deleted.
		id: 'a4',
		prompt: 'Remove the old file and rename the helper.',
		durationMs: 25000,
		items: [
			{ say: 'Deleting the unused file, then fixing the helper name.' },
			{
				tool: 'a4-d',
				name: 'write',
				view: diff('/sample/app/src/legacy/old-helper.ts', 'export const old = 1\n', ''),
			},
			{
				tool: 'a4-e',
				name: 'edit',
				view: diff(
					'/sample/app/src/helpers.ts',
					'export const helper = 1\n',
					'export const sidebarHelper = 1\n',
				),
			},
			{ answer: 'Done.' },
		],
	},
]

export function activityMessages(): ChatMessage[] {
	return sampleTurns.flatMap((turn): ChatMessage[] => [
		{ role: 'user', text: turn.prompt },
		...turn.items.flatMap((item): ChatMessage[] =>
			'say' in item
				? [{ role: 'assistant', text: item.say, phase: 'commentary' }]
				: 'answer' in item
					? [{ role: 'assistant', text: item.answer, status: 'completed' }]
					: [],
		),
	])
}

export function activityWork(): HistoryWorkSnapshot {
	const work: HistoryWorkSnapshot = { v: 1, partial: false, messages: [], turns: [], tools: [] }
	let order = 1
	let index = 0
	for (const turn of sampleTurns) {
		work.turns.push({
			turnId: turn.id,
			userMessageId: `${turn.id}-u`,
			order: order++,
			status: 'completed',
			reason: 'end_turn',
			durationMs: turn.durationMs,
		})
		work.messages.push({
			index: index++,
			messageId: `${turn.id}-u`,
			turnId: turn.id,
			order: order++,
		})
		for (const item of turn.items) {
			if ('tool' in item)
				work.tools.push({
					turnId: turn.id,
					toolUseId: item.tool,
					name: item.name,
					order: order++,
					status: 'completed',
					presentation: item.view,
				})
			else
				work.messages.push({
					index: index++,
					messageId: `${turn.id}-m${index}`,
					turnId: turn.id,
					order: order++,
				})
		}
	}
	return work
}

export function activityConversation(projectId: string, updatedAt: string): ConversationView {
	return { id: activityConversationId, projectId, title: 'Activity rows', updatedAt }
}

interface Step {
	name: string
	after: number
	update: Extract<DesktopEvent, { kind: 'update' }>['update']
}

/** A running turn: Running command, Ran command, Editing, Edited, then the answer. */
function liveSteps(): Step[] {
	const call = (
		toolCallId: string,
		title: string,
		status: 'pending' | 'completed',
		view: ToolCallView,
	): Step['update'] => ({ kind: 'tool_call', toolCallId, title, status, view })
	const edit = diff('src/app.css', css, '.row {\n  padding: 8px;\n}\n')
	return [
		{
			name: 'say',
			after: 300,
			update: {
				kind: 'agent_message_chunk',
				text: 'I will read the notes, then update the styles.',
				phase: 'commentary',
				messageId: 'live-say',
			},
		},
		{
			name: 'cmd',
			after: 600,
			update: call('live-c', 'bash', 'pending', command('cat notes.md', '')),
		},
		{
			name: 'cmd-done',
			after: 4000,
			update: call('live-c', 'bash', 'completed', command('cat notes.md', 'Make rows roomier.')),
		},
		{
			name: 'read',
			after: 300,
			update: call('live-r', 'read', 'pending', explore('Read notes.md')),
		},
		{
			name: 'read-done',
			after: 2500,
			update: call('live-r', 'read', 'completed', explore('Read notes.md')),
		},
		{ name: 'edit', after: 300, update: call('live-e', 'edit', 'pending', edit) },
		{ name: 'edit-done', after: 4000, update: call('live-e', 'edit', 'completed', edit) },
		{
			name: 'answer',
			after: 400,
			update: {
				kind: 'agent_message_chunk',
				text: 'The rows now have more room.',
				messageId: 'live-answer',
			},
		},
	]
}

export interface ActivityLive {
	/** `hold` stops after the step of that name, so a screenshot can compare the live state. */
	start(options?: { hold?: string }): Promise<void>
}

/** Timers are the only clock; nothing here runs unless the preview asks for it. */
export function createActivityLive(
	view: ConversationView,
	emit: (event: DesktopEvent) => void,
): ActivityLive {
	return {
		start({ hold } = {}) {
			const prompt = 'Update the row padding from my notes.'
			emit({ kind: 'prompt', sessionId: view.id, prompt, at: Date.now() })
			emit({ kind: 'state', sessionId: view.id, running: true, queued: [] })
			const steps = liveSteps()
			return new Promise((resolve) => {
				const next = (index: number) => {
					const step = steps[index]
					if (!step) {
						emit({
							kind: 'update',
							projectId: view.projectId,
							sessionId: view.id,
							update: { kind: 'turn_ended', stopReason: 'end_turn' },
						})
						emit({ kind: 'state', sessionId: view.id, running: false, queued: [] })
						resolve()
						return
					}
					setTimeout(() => {
						emit({
							kind: 'update',
							projectId: view.projectId,
							sessionId: view.id,
							update: step.update,
						})
						if (step.name === hold) resolve()
						else next(index + 1)
					}, step.after)
				}
				next(0)
			})
		},
	}
}
