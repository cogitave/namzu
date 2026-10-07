import type { ToolCallView } from '@namzu/sdk'
import type { ProjectedToolCall, ThreadState } from '../shared/projection.js'

export type ToolTranscriptState =
	| 'waiting'
	| 'running'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'interrupted'
	| 'skipped'

export interface ToolTranscriptPresentation {
	label: string
	state: ToolTranscriptState
	statusLabel: string
	quietCompleted?: true
	callDetail?: ToolCallView
	detailView?: ToolCallView
}

const statusLabels: Record<ToolTranscriptState, string> = {
	waiting: 'Waiting for approval',
	running: 'Running',
	completed: 'Completed',
	failed: 'Failed',
	cancelled: 'Cancelled',
	interrupted: 'Interrupted',
	skipped: 'Skipped',
}

function nonBlank(text?: string): string | undefined {
	return text?.trim() ? text : undefined
}

function caption(view?: ToolCallView): string | undefined {
	const text =
		view?.kind === 'generic'
			? view.label
			: view?.kind === 'diff'
				? nonBlank(view.label) || view.path
				: view?.command
	return (
		text
			?.split(/\r?\n/)
			.find((line) => line.trim())
			?.trim() || undefined
	)
}

function toolState(thread: ThreadState, id: string, tool: ProjectedToolCall): ToolTranscriptState {
	if (tool.historicalStatus === 'skipped') return 'skipped'
	if (tool.status !== 'pending') {
		if (tool.view.kind === 'generic' && tool.view.outcome === 'cancelled') return 'cancelled'
		return tool.status
	}
	const active =
		thread.running &&
		thread.stopReason === undefined &&
		thread.activeToolIds.includes(id) &&
		thread.timeline.some(
			(entry) => entry.kind === 'tool' && entry.id === id && entry.turn === thread.turn,
		)
	if (!active) return 'interrupted'
	return thread.permissions.some((permission) =>
		permission.calls.some((call) => call.id === tool.toolCallId),
	)
		? 'waiting'
		: 'running'
}

function commandLabel(command: string, state: ToolTranscriptState): string {
	const prefix: Record<ToolTranscriptState, string> = {
		waiting: 'Waiting to run',
		running: 'Running',
		completed: 'Ran',
		failed: 'Command failed:',
		cancelled: 'Cancelled command:',
		interrupted: 'Interrupted',
		skipped: 'Skipped command:',
	}
	return `${prefix[state]} ${command}`
}

function diffLabel(path: string, state: ToolTranscriptState): string {
	const prefix: Record<ToolTranscriptState, string> = {
		waiting: 'Waiting to edit',
		running: 'Editing',
		completed: 'Edited',
		failed: 'Failed edit of',
		cancelled: 'Cancelled edit of',
		interrupted: 'Interrupted edit of',
		skipped: 'Skipped edit of',
	}
	return `${prefix[state]} ${path}`
}

function observedActionLabel(
	tool: ProjectedToolCall,
	state: ToolTranscriptState,
): string | undefined {
	const hosted = tool.toolCallId.startsWith('provider-hosted-web-search:')
	const search = hosted && tool.title === 'Web search'
	const fetch = hosted && tool.title === 'Web fetch'
	const earlier = tool.title === 'search_conversation'
	if (!search && !fetch && !earlier) return undefined
	const names = earlier
		? {
				waiting: 'Waiting to check earlier messages',
				running: 'Checking earlier messages',
				completed: 'Checked earlier messages',
				failed: 'Could not check earlier messages',
				cancelled: 'Stopped checking earlier messages',
				interrupted: 'Earlier message lookup interrupted',
				skipped: 'Skipped earlier message lookup',
			}
		: search
			? {
					waiting: 'Waiting to search the web',
					running: 'Searching the web',
					completed: 'Searched the web',
					failed: 'Web search failed',
					cancelled: 'Web search cancelled',
					interrupted: 'Web search interrupted',
					skipped: 'Web search skipped',
				}
			: {
					waiting: 'Waiting to fetch a page',
					running: 'Fetching a page',
					completed: 'Fetched a page',
					failed: 'Page fetch failed',
					cancelled: 'Page fetch cancelled',
					interrupted: 'Page fetch interrupted',
					skipped: 'Page fetch skipped',
				}
	return names[state]
}

/** Present only admitted tool metadata; never infer outcomes from result text. */
export function toolTranscriptPresentation(
	thread: ThreadState,
	id: string,
): ToolTranscriptPresentation | undefined {
	const tool = thread.tools[id]
	if (!tool) return undefined
	const state = toolState(thread, id, tool)
	const view = tool.view
	const callCaption = caption(tool.callView)
	const title = nonBlank(tool.title)
	let label = callCaption || caption(view) || title || 'Tool action'
	let detailView: ToolCallView | undefined = view
	const observed = observedActionLabel(tool, state)
	if (observed) {
		label = observed
		if (view.kind === 'generic' && !view.label.trim()) detailView = undefined
	} else if (view.kind === 'terminal') {
		const command =
			nonBlank(view.command) ||
			(tool.callView?.kind === 'terminal' ? nonBlank(tool.callView.command) : undefined)
		if (command) label = commandLabel(command, state)
	} else if (view.kind === 'diff') {
		label =
			nonBlank(view.label) ||
			diffLabel(nonBlank(view.path) || callCaption || title || 'document', state)
	} else {
		// A hidden success suppresses its redundant receipt, never the action row.
		if (state === 'completed' && view.visibility === 'hidden') detailView = undefined
		else if (
			!view.label.trim() ||
			(!/[\r\n]/.test(view.label) && view.label.trim() === label.trim())
		)
			detailView = undefined
	}
	return {
		label,
		state,
		statusLabel: statusLabels[state],
		...(observed && state === 'completed' ? { quietCompleted: true as const } : {}),
		...(observed && tool.callView?.kind === 'generic' && tool.callView.label.trim()
			? { callDetail: tool.callView }
			: {}),
		...(detailView ? { detailView } : {}),
	}
}
