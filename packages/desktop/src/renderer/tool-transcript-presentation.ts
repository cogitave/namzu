import type { ToolCallView } from '@namzu/sdk'
import type { ProjectedToolCall, ThreadState } from '../shared/projection.js'
import { baseName } from './turn-changes.js'

export type ToolTranscriptState =
	| 'waiting'
	| 'running'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'interrupted'
	| 'skipped'
	| 'declined'

/** What an action row is about; picks its icon, its label and what a click does. */
export type ActionKind = 'command' | 'edit' | 'read' | 'search' | 'web' | 'lookup' | 'other'

export interface ActionFile {
	/** The base name drawn in the row. */
	name: string
	/** The path as the tool named it; the receipt's own spelling, so it matches the Changes list. */
	path: string
}

export interface ToolTranscriptPresentation {
	label: string
	kind: ActionKind
	/** Text before the file name; the row draws `lead` and then the name, so `label` is both. */
	lead?: string
	file?: ActionFile
	operation?: 'created' | 'edited' | 'deleted'
	/** One line shown on hover or focus: the command, or the full search text. */
	tooltip?: string
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
	declined: 'Declined',
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
		// A structured field from the review answer, never a reading of the refusal text.
		if (tool.view.kind === 'generic' && tool.view.declined) return 'declined'
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

function commandLabel(state: ToolTranscriptState): string {
	const labels: Record<ToolTranscriptState, string> = {
		waiting: 'Waiting to run command',
		running: 'Running command',
		completed: 'Ran command',
		failed: 'Command failed',
		cancelled: 'Command cancelled',
		interrupted: 'Command interrupted',
		skipped: 'Command skipped',
		declined: 'Declined command',
	}
	return labels[state]
}

type Operation = 'created' | 'edited' | 'deleted'

/** A receipt does not say create or delete; an empty side does. */
export function diffOperation(view: { before: string; after: string }): Operation {
	if (!view.before && view.after) return 'created'
	if (view.before && !view.after) return 'deleted'
	return 'edited'
}

function diffLead(operation: Operation, state: ToolTranscriptState): string {
	const done = operation === 'created' ? 'Created' : operation === 'deleted' ? 'Deleted' : 'Edited'
	const prefix: Record<ToolTranscriptState, string> = {
		waiting: 'Waiting to edit',
		running: 'Editing',
		completed: done,
		failed: "Couldn't edit",
		cancelled: 'Cancelled edit of',
		interrupted: 'Interrupted edit of',
		skipped: 'Skipped edit of',
		declined: 'Declined edit to',
	}
	return prefix[state]
}

function readLead(state: ToolTranscriptState): string {
	const prefix: Record<ToolTranscriptState, string> = {
		waiting: 'Waiting to read',
		running: 'Reading',
		completed: 'Read',
		failed: "Couldn't read",
		cancelled: 'Cancelled read of',
		interrupted: 'Interrupted read of',
		skipped: 'Skipped read of',
		declined: 'Declined read of',
	}
	return prefix[state]
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function firstLine(text: string): string {
	return (
		text
			.split(/\r?\n/)
			.find((line) => line.trim())
			?.trim() ?? ''
	)
}

type Exploration =
	| { kind: 'read'; path: string }
	| { kind: 'grep'; pattern: string; dir: string }
	| { kind: 'glob'; pattern: string; dir: string }

/** The SDK names these in its call label ("Read p", "Search x in d", "Find x in d"); there is no field for them. */
function exploration(tool: ProjectedToolCall): Exploration | undefined {
	// A saved conversation keeps only the final view, which these tools leave as their call label.
	const named = tool.callView ?? tool.view
	const label = named.kind === 'generic' ? firstLine(named.label) : ''
	if (!label) return undefined
	if (tool.title === 'read' && label.startsWith('Read ')) {
		const path = label.slice(5).trim()
		return path ? { kind: 'read', path } : undefined
	}
	const find = tool.title === 'glob' ? 'Find ' : tool.title === 'grep' ? 'Search ' : undefined
	if (!find || !label.startsWith(find)) return undefined
	const rest = label.slice(find.length)
	const at = rest.lastIndexOf(' in ')
	const pattern = at < 0 ? rest : rest.slice(0, at)
	const dir = at < 0 ? '.' : rest.slice(at + 4).trim() || '.'
	return pattern.trim()
		? { kind: tool.title === 'glob' ? 'glob' : 'grep', pattern: pattern.trim(), dir }
		: undefined
}

function searchLead(kind: 'grep' | 'glob', state: ToolTranscriptState): string {
	const grep: Record<ToolTranscriptState, string> = {
		waiting: 'Waiting to search for',
		running: 'Searching for',
		completed: 'Searched for',
		failed: "Couldn't search for",
		cancelled: 'Cancelled search for',
		interrupted: 'Interrupted search for',
		skipped: 'Skipped search for',
		declined: 'Declined search for',
	}
	const glob: Record<ToolTranscriptState, string> = {
		waiting: 'Waiting to list files in',
		running: 'Listing files in',
		completed: 'Listed files in',
		failed: "Couldn't list files in",
		cancelled: 'Cancelled listing files in',
		interrupted: 'Interrupted listing files in',
		skipped: 'Skipped listing files in',
		declined: 'Declined listing files in',
	}
	return (kind === 'grep' ? grep : glob)[state]
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
				declined: 'Declined earlier message lookup',
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
					declined: 'Web search declined',
				}
			: {
					waiting: 'Waiting to fetch a page',
					running: 'Fetching a page',
					completed: 'Fetched a page',
					failed: 'Page fetch failed',
					cancelled: 'Page fetch cancelled',
					interrupted: 'Page fetch interrupted',
					skipped: 'Page fetch skipped',
					declined: 'Page fetch declined',
				}
	return names[state]
}

const PAL_MESSAGE_TOOL = 'send_pal_message'

/**
 * Who a message to a Pal was for. The tool authors "Message to <name>" for the call and
 * "Sent to <name>'s inbox" for the receipt, and a saved conversation keeps one of them as
 * its label; no field names the Pal, and a Pal's own `send_pal_message` row carries neither.
 */
function palMessageName(tool: ProjectedToolCall): string | undefined {
	if (tool.title !== PAL_MESSAGE_TOOL) return undefined
	const named = tool.callView ?? tool.view
	const label = named.kind === 'generic' ? firstLine(named.label) : ''
	const call = /^Message to (.+)$/.exec(label)?.[1]?.trim()
	if (call && call !== 'a Pal') return call
	const receipt = /^Sent to (.+)'s inbox$/.exec(label)?.[1]?.trim()
	return receipt || undefined
}

function palMessageLabel(name: string, state: ToolTranscriptState): string {
	const labels: Record<ToolTranscriptState, string> = {
		waiting: `Waiting to message ${name}`,
		running: `Messaging ${name}`,
		completed: `Messaged ${name}`,
		failed: `Couldn't message ${name}`,
		cancelled: `Cancelled message to ${name}`,
		interrupted: `Interrupted message to ${name}`,
		skipped: `Skipped message to ${name}`,
		declined: `Declined message to ${name}`,
	}
	return labels[state]
}

const FILE_TOOLS = new Set(['edit', 'write', 'multiedit'])
const COMMAND_TOOLS = new Set(['bash', 'shell', 'run_command', 'exec'])

/**
 * A call the person said No to. The recorded view names its target (a path, a
 * command) and may carry their note; the row says what was declined and shows
 * the note when it is opened.
 */
function declinedPresentation(tool: ProjectedToolCall): ToolTranscriptPresentation {
	const view = tool.view as Extract<ToolCallView, { kind: 'generic' }>
	const target = nonBlank(firstLine(view.label))
	const name = tool.title.toLowerCase()
	const note = nonBlank(view.declined?.note)
	const palName = palMessageName(tool)
	let label = palName
		? palMessageLabel(palName, 'declined')
		: `Declined ${tool.title.replace(/[_-]+/g, ' ').trim().toLowerCase() || 'action'}`
	let kind: ActionKind = 'other'
	let lead: string | undefined
	let file: ActionFile | undefined
	let tooltip: string | undefined
	if (FILE_TOOLS.has(name) && target) {
		kind = 'edit'
		lead = name === 'write' ? 'Declined write to' : 'Declined edit to'
		file = { name: baseName(target), path: target }
		label = `${lead} ${file.name}`
	} else if (name === 'read' && target) {
		kind = 'read'
		lead = 'Declined read of'
		file = { name: baseName(target), path: target }
		label = `${lead} ${file.name}`
	} else if (COMMAND_TOOLS.has(name)) {
		kind = 'command'
		label = commandLabel('declined')
		if (target) tooltip = clip(target, 200)
	}
	return {
		label,
		kind,
		...(lead ? { lead } : {}),
		...(file ? { file } : {}),
		...(tooltip ? { tooltip } : {}),
		state: 'declined',
		statusLabel: statusLabels.declined,
		...(note ? { detailView: { kind: 'generic', label: `You said: ${note}` } as const } : {}),
	}
}

/** Present only admitted tool metadata; never infer outcomes from result text. */
export function toolTranscriptPresentation(
	thread: ThreadState,
	id: string,
): ToolTranscriptPresentation | undefined {
	const tool = thread.tools[id]
	if (!tool) return undefined
	const state = toolState(thread, id, tool)
	if (state === 'declined') return declinedPresentation(tool)
	const view = tool.view
	const callCaption = caption(tool.callView)
	const title = nonBlank(tool.title)
	let label = callCaption || caption(view) || title || 'Tool action'
	let detailView: ToolCallView | undefined = view
	let kind: ActionKind = 'other'
	let lead: string | undefined
	let file: ActionFile | undefined
	let operation: Operation | undefined
	let tooltip: string | undefined
	const observed = observedActionLabel(tool, state)
	const explored = exploration(tool)
	const palName = palMessageName(tool)
	if (palName) {
		// The row names the Pal and says the message reached its inbox, never that it was read.
		label = palMessageLabel(palName, state)
		if (state === 'completed') tooltip = 'Sent to inbox'
		detailView = undefined
	} else if (observed) {
		label = observed
		kind = tool.title === 'search_conversation' ? 'lookup' : 'web'
		if (view.kind === 'generic' && !view.label.trim()) detailView = undefined
	} else if (view.kind === 'terminal') {
		kind = 'command'
		const command =
			nonBlank(view.command) ||
			(tool.callView?.kind === 'terminal' ? nonBlank(tool.callView.command) : undefined)
		// Without a command the caption the call came with is the best name there is.
		if (command) {
			label = commandLabel(state)
			tooltip = clip(firstLine(command), 200)
		}
	} else if (view.kind === 'diff') {
		// The Before/After block is not drawn in the transcript; the Changes panel shows the diff.
		kind = 'edit'
		detailView = undefined
		const path = nonBlank(view.path)
		operation = diffOperation(view)
		lead = diffLead(operation, state)
		const name = path ? baseName(path) : callCaption || title || 'document'
		const authored = path ? undefined : nonBlank(view.label)
		if (path) file = { name, path }
		label = authored ?? `${lead} ${name}`
	} else if (explored?.kind === 'read') {
		kind = 'read'
		detailView = undefined
		lead = readLead(state)
		file = { name: baseName(explored.path), path: explored.path }
		label = `${lead} ${file.name}`
	} else if (explored) {
		kind = 'search'
		lead = searchLead(explored.kind, state)
		const subject =
			explored.kind === 'grep'
				? explored.pattern
				: explored.dir === '.'
					? 'this folder'
					: explored.dir
		label = `${lead} ${clip(subject, 60)}`
		tooltip = clip(firstLine(callCaption ?? caption(view) ?? ''), 200)
		if (view.kind === 'generic' && view.label.trim() === (callCaption ?? caption(view)))
			detailView = undefined
	} else {
		// A hidden success suppresses its redundant receipt, never the action row.
		if (view.kind === 'generic' && state === 'completed' && view.visibility === 'hidden')
			detailView = undefined
		else if (
			view.kind === 'generic' &&
			(!view.label.trim() || (!/[\r\n]/.test(view.label) && view.label.trim() === label.trim()))
		)
			detailView = undefined
	}
	// A command with nothing printed has no output to open, whether it finished or failed:
	// a restored row's output is simply not kept, and an empty panel would claim otherwise.
	if (
		state !== 'running' &&
		state !== 'waiting' &&
		detailView?.kind === 'terminal' &&
		!detailView.output.trim()
	)
		detailView = undefined
	// A row restored without its view is only a name: nothing to open, and the tooltip says why.
	if (tool.detailUnavailable) {
		detailView = undefined
		tooltip = 'Details were not saved'
	}
	return {
		label,
		kind,
		...(lead ? { lead } : {}),
		...(file ? { file } : {}),
		...(operation ? { operation } : {}),
		...(tooltip ? { tooltip } : {}),
		state,
		statusLabel: statusLabels[state],
		...(observed && state === 'completed' ? { quietCompleted: true as const } : {}),
		...(observed && tool.callView?.kind === 'generic' && tool.callView.label.trim()
			? { callDetail: tool.callView }
			: {}),
		...(detailView ? { detailView } : {}),
	}
}
