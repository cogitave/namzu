import type { ToolCallView, ToolFacts, ToolFailureReason } from '@namzu/sdk'
import type { ProjectedToolCall, ThreadState } from '../shared/projection.js'
import { changeTotals } from './changes-totals.js'
import { humanBytes } from './tool-output.js'
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

/** One stream of a command's output, as the SDK windowed it: the first lines, the last, and the gap. */
export interface StreamText {
	head: string
	tail?: string
	/** Lines left out between `head` and `tail`. */
	omitted: number
	/** Lines in the whole output. */
	total: number
}

/** What the row opens to. Built from typed fields; the model's wording is never read. */
export type ToolBody =
	| { kind: 'notice'; text: string }
	| { kind: 'text'; text: string }
	| {
			kind: 'streams'
			/** The command when its headline had to cut it short, so the whole line can still be read. */
			command?: string
			stdout?: StreamText
			stderr?: StreamText
	  }

export interface ToolTranscriptPresentation {
	label: string
	kind: ActionKind
	/** Text before the file name; the row draws `lead` and then the name, so `label` is both. */
	lead?: string
	file?: ActionFile
	/** What the row says before `tail`, for a row with no file name. Equal to `label` without a tail. */
	main?: string
	/** Drawn after the headline, with its own punctuation: ": file not found", " · failed (exit 3)". */
	tail?: string
	/** Lines added and removed by an edit or a created file. */
	stats?: { added: number; removed: number }
	/** What the row opens to, instead of `detailView`, when the tool reported typed facts. */
	body?: ToolBody
	operation?: 'created' | 'edited' | 'deleted'
	/** One line shown on hover or focus: the command, or the full search text. */
	tooltip?: string
	state: ToolTranscriptState
	statusLabel: string
	quietCompleted?: true
	callDetail?: ToolCallView
	detailView?: ToolCallView
	/** What the person typed when they declined and said what to do instead; the transcript shows it. */
	note?: string
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

function searchLead(
	kind: 'grep' | 'glob',
	state: ToolTranscriptState,
	/** A pattern follows the lead, not a folder ("Listed files in this folder"). */
	byPattern = false,
): string {
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
	const glob: Record<ToolTranscriptState, string> = byPattern
		? {
				waiting: 'Waiting to list',
				running: 'Listing',
				completed: 'Listed',
				failed: "Couldn't list",
				cancelled: 'Cancelled listing',
				interrupted: 'Interrupted listing',
				skipped: 'Skipped listing',
				declined: 'Declined listing',
			}
		: {
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

/** The first line of a command, collapsed to one line and cut to what a headline can hold. */
export function shortCommand(command: string, max = 60): string {
	const line = firstLine(command).replace(/\s+/g, ' ')
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

function commandVerb(state: ToolTranscriptState): string {
	const verbs: Record<ToolTranscriptState, string> = {
		waiting: 'Waiting to run',
		running: 'Running',
		completed: 'Ran',
		failed: 'Ran',
		cancelled: 'Cancelled',
		interrupted: 'Interrupted',
		skipped: 'Skipped',
		declined: 'Declined',
	}
	return verbs[state]
}

function plural(count: number, one: string, many: string): string {
	return `${count.toLocaleString('en')} ${count === 1 ? one : many}`
}

type CommandFacts = Extract<ToolFacts, { kind: 'command' }>

/** How a command that did not succeed ended, from its exit code and never from its text. */
function commandOutcome(facts: CommandFacts): string {
	if (facts.timedOut) return 'timed out'
	if (facts.exitCode !== undefined && facts.exitCode !== 0) return `failed (exit ${facts.exitCode})`
	if (facts.signal) return 'stopped'
	return 'failed'
}

function streamText(window: {
	head: string
	tail?: string
	omittedLines?: number
	totalLines: number
}): StreamText {
	return {
		head: window.head,
		...(window.tail ? { tail: window.tail } : {}),
		omitted: window.omittedLines ?? 0,
		total: window.totalLines,
	}
}

/** What a finished command opens to: its streams, or a plain note when there is nothing to draw. */
function commandBody(
	facts: CommandFacts,
	command: string | undefined,
	shown: string,
): ToolBody | undefined {
	if (facts.binary)
		return {
			kind: 'notice',
			text: `Binary output, ${humanBytes(facts.binary.bytes)}`,
		}
	const stdout = facts.stdout && facts.stdout.totalLines > 0 ? streamText(facts.stdout) : undefined
	const stderr = facts.stderr && facts.stderr.totalLines > 0 ? streamText(facts.stderr) : undefined
	if (!stdout && !stderr) return undefined
	const whole = command?.trim()
	const cut = whole !== undefined && whole !== shown
	return {
		kind: 'streams',
		...(cut && whole ? { command: whole } : {}),
		...(stdout ? { stdout } : {}),
		...(stderr ? { stderr } : {}),
	}
}

const FAILURE_TEXT: Record<ToolFailureReason, string> = {
	not_found: 'file not found',
	permission_denied: 'no permission to open it',
	not_a_file: 'not a file',
	already_exists: 'it already exists',
	blocked: 'not allowed',
	needs_administrator: 'needs administrator rights',
	unknown_tool: 'unknown tool',
	timed_out: 'timed out',
	invalid_input: 'invalid request',
}

function failureLead(kind: ActionKind): string {
	return kind === 'read'
		? "Couldn't read"
		: kind === 'edit'
			? "Couldn't change"
			: kind === 'search'
				? "Couldn't search"
				: "Couldn't open"
}

/** The facts the call itself carried, before it ran. */
function callFactsOf(tool: ProjectedToolCall): ToolFacts | undefined {
	const call = tool.callView
	return call?.kind === 'generic' ? call.facts : undefined
}

function pathOfFacts(facts: ToolFacts | undefined): string | undefined {
	return facts && (facts.kind === 'read' || facts.kind === 'write' || facts.kind === 'edit')
		? facts.path
		: undefined
}

/** A folder as a person names it: nothing for the project's own, the name for one given in full. */
function folderName(path: string | undefined): string | undefined {
	if (!path || path === '.' || path === './') return undefined
	const trimmed = path.replace(/[\\/]+$/, '')
	return /^(?:[\\/]|[A-Za-z]:)/.test(trimmed) ? baseName(trimmed) : trimmed
}

export interface FactsRow {
	label: string
	kind: ActionKind
	lead?: string
	file?: ActionFile
	main?: string
	tail?: string
	tooltip?: string
	body?: ToolBody
	stats?: { added: number; removed: number }
	operation?: 'created' | 'edited' | 'deleted'
}

/** The headline of a command from the command itself and how its call stands. */
function commandRow(
	state: ToolTranscriptState,
	command: string | undefined,
	facts: CommandFacts | undefined,
): FactsRow {
	const shown = command ? shortCommand(command) : ''
	const main = shown ? `${commandVerb(state)} ${shown}` : commandLabel(state)
	// A command that ran and failed says so beside its name; a refused or stopped one is its own state.
	const tail = state === 'failed' ? ` · ${facts ? commandOutcome(facts) : 'failed'}` : ''
	const body =
		facts && state !== 'running' && state !== 'waiting'
			? commandBody(facts, command, shown)
			: undefined
	return {
		label: `${main}${tail}`,
		main,
		kind: 'command',
		...(tail ? { tail } : {}),
		...(command?.trim() ? { tooltip: clip(command.trim(), 1000) } : {}),
		...(body ? { body } : {}),
	}
}

function searchRow(
	state: ToolTranscriptState,
	facts: Extract<ToolFacts, { kind: 'search' | 'list' }>,
): FactsRow {
	const grep = facts.kind === 'search'
	const lead = searchLead(grep ? 'grep' : 'glob', state, true)
	const folder = folderName(facts.path)
	const subject = clip(facts.pattern, 60)
	const main = `${lead} ${subject}${!grep && folder ? ` in ${folder}` : ''}`
	let found = ''
	if (state === 'completed') {
		if (facts.kind === 'search' && facts.matches !== undefined) {
			found =
				facts.matches === 0
					? 'no matches'
					: `${plural(facts.matches, 'match', 'matches')}${
							facts.filesMatched !== undefined
								? ` in ${plural(facts.filesMatched, 'file', 'files')}`
								: ''
						}`
		} else if (facts.kind === 'list' && facts.count !== undefined) {
			found = facts.count === 0 ? 'no files' : plural(facts.count, 'file', 'files')
		}
		if (found && facts.truncated) found = `${found}, more not shown`
	}
	const tail = found ? ` · ${found}` : ''
	return {
		label: `${main}${tail}`,
		main,
		kind: 'search',
		...(tail ? { tail } : {}),
		tooltip: clip(
			`${grep ? 'Searched for' : 'Listed'} ${facts.pattern} in ${folder ?? 'this folder'}`,
			200,
		),
	}
}

function failureRow(
	tool: ProjectedToolCall,
	facts: Extract<ToolFacts, { kind: 'failure' }>,
	call: ToolFacts | undefined,
): FactsRow {
	const name = tool.title.toLowerCase()
	const command = COMMAND_TOOLS.has(name) || call?.kind === 'command'
	if (facts.reason === 'unknown_tool') {
		const main = `Namzu tried a tool it doesn't have${facts.subject ? ` (${facts.subject})` : ''}`
		return { label: main, main, kind: 'other' }
	}
	if (facts.reason === 'blocked' || facts.reason === 'needs_administrator') {
		const what = command ? 'this command' : 'this action'
		const main =
			facts.reason === 'needs_administrator'
				? `Blocked: ${what} needs administrator rights`
				: `Blocked: ${what} isn't allowed`
		const typed = call?.kind === 'command' ? nonBlank(call.command) : undefined
		return {
			label: main,
			main,
			kind: command ? 'command' : 'other',
			...(typed ? { tooltip: clip(typed.trim(), 1000) } : {}),
		}
	}
	const kind: ActionKind =
		call?.kind === 'read'
			? 'read'
			: call?.kind === 'search' || call?.kind === 'list'
				? 'search'
				: FILE_TOOLS.has(name) || call?.kind === 'edit' || call?.kind === 'write'
					? 'edit'
					: command
						? 'command'
						: 'other'
	const path = facts.subject ?? pathOfFacts(call)
	const tail = `: ${FAILURE_TEXT[facts.reason]}`
	if (path) {
		const lead = failureLead(kind)
		const file = { name: baseName(path), path }
		return { label: `${lead} ${file.name}${tail}`, kind, lead, file, tail }
	}
	const main = `${failureLead(kind)} it`
	return { label: `${main}${tail}`, main, kind, tail }
}

/**
 * The row for a call whose tool reported typed facts (or whose call said what it was about). Every
 * word comes from a field: the exit code, the path, the count. `undefined` leaves the row to the
 * generic rules, which is what a diff does for the edit and write receipts.
 */
function factsRow(
	tool: ProjectedToolCall,
	state: ToolTranscriptState,
	facts: ToolFacts,
	call: ToolFacts | undefined,
): FactsRow | undefined {
	switch (facts.kind) {
		case 'command': {
			const view = tool.view
			const command =
				nonBlank(facts.command) ||
				(call?.kind === 'command' ? nonBlank(call.command) : undefined) ||
				(view.kind === 'terminal' ? nonBlank(view.command) : undefined)
			return commandRow(state, command, facts)
		}
		case 'read': {
			const lead = readLead(state)
			const file = { name: baseName(facts.path), path: facts.path }
			const tail =
				state === 'completed' && facts.binary
					? ` · Binary file${facts.bytes !== undefined ? `, ${humanBytes(facts.bytes)}` : ''}`
					: ''
			return {
				label: `${lead} ${file.name}${tail}`,
				kind: 'read',
				lead,
				file,
				...(tail ? { tail } : {}),
			}
		}
		case 'search':
		case 'list':
			return searchRow(state, facts)
		case 'edit': {
			const path = facts.path ?? pathOfFacts(call)
			if (!path) return undefined
			const lead = diffLead('edited', state)
			const file = { name: baseName(path), path }
			return {
				label: `${lead} ${file.name}`,
				kind: 'edit',
				lead,
				file,
				operation: 'edited',
			}
		}
		case 'write': {
			const lead = writeLead(facts.operation, state)
			const file = { name: baseName(facts.path), path: facts.path }
			return {
				label: `${lead} ${file.name}`,
				kind: 'edit',
				lead,
				file,
				operation: facts.operation === 'created' ? 'created' : 'edited',
				...(facts.added !== undefined || facts.removed !== undefined
					? { stats: { added: facts.added ?? 0, removed: facts.removed ?? 0 } }
					: {}),
			}
		}
		case 'failure':
			return failureRow(tool, facts, call)
	}
}

function writeLead(
	operation: Extract<ToolFacts, { kind: 'write' }>['operation'],
	state: ToolTranscriptState,
): string {
	if (state !== 'completed') return diffLead('edited', state)
	return operation === 'created'
		? 'Created'
		: operation === 'updated'
			? 'Updated'
			: operation === 'unchanged'
				? 'No changes to'
				: 'Wrote'
}

const PAL_MESSAGE_TOOL = 'send_pal_message'

/**
 * Who a message to a Pal was for. The tool authors "Message to <name>" for the call and
 * "Sent to <name>'s inbox" for the receipt, and a saved conversation keeps one of them as
 * its label; no field names the Pal, and a Pal's own `send_pal_message` row carries neither.
 */
export function palMessageName(tool: ProjectedToolCall): string | undefined {
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
 * command) and may carry their note; the row says what was declined and the note
 * is drawn under the work block as the person's own words.
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
		...(note ? { note } : {}),
	}
}

const statsCache = new WeakMap<object, { added: number; removed: number }>()

/** Lines an edit added and removed, worked out once per receipt. */
function diffStats(view: Extract<ToolCallView, { kind: 'diff' }>): {
	added: number
	removed: number
} {
	const hit = statsCache.get(view)
	if (hit) return hit
	const totals = changeTotals([view])
	const stats = { added: totals.added, removed: totals.removed }
	statsCache.set(view, stats)
	return stats
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
	let main: string | undefined
	let tail: string | undefined
	let body: ToolBody | undefined
	let stats: { added: number; removed: number } | undefined
	const observed = observedActionLabel(tool, state)
	const explored = exploration(tool)
	const palName = palMessageName(tool)
	// What the tool reported as fields; before it finished, what the call was about.
	const call = callFactsOf(tool)
	const facts = tool.facts ?? call
	const typed =
		!palName && !observed && view.kind !== 'diff' && facts
			? factsRow(tool, state, facts, call)
			: undefined
	if (palName) {
		// The row names the Pal and says the message reached its inbox, never that it was read.
		label = palMessageLabel(palName, state)
		if (state === 'completed') tooltip = 'Sent to inbox'
		detailView = undefined
	} else if (observed) {
		label = observed
		kind = tool.title === 'search_conversation' ? 'lookup' : 'web'
		if (view.kind === 'generic' && !view.label.trim()) detailView = undefined
	} else if (view.kind === 'diff') {
		// The Before/After block is not drawn in the transcript; the Changes panel shows the diff.
		kind = 'edit'
		detailView = undefined
		const path = nonBlank(view.path)
		operation = diffOperation(view)
		const written = tool.facts?.kind === 'write' ? tool.facts.operation : undefined
		lead = written && state === 'completed' ? writeLead(written, state) : diffLead(operation, state)
		const name = path ? baseName(path) : callCaption || title || 'document'
		const authored = path ? undefined : nonBlank(view.label)
		if (path) file = { name, path }
		label = authored ?? `${lead} ${name}`
		if (state === 'completed') stats = diffStats(view)
	} else if (typed) {
		// The words come from typed fields; the model's receipt is not drawn.
		label = typed.label
		kind = typed.kind
		lead = typed.lead
		file = typed.file
		main = typed.main
		tail = typed.tail
		tooltip = typed.tooltip
		body = typed.body
		stats = typed.stats
		operation = typed.operation
		detailView = undefined
	} else if (explored?.kind === 'read') {
		// A conversation saved before tools reported fields: the call's own label is all there is.
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
	} else if (view.kind === 'terminal') {
		kind = 'command'
		const command =
			nonBlank(view.command) ||
			(tool.callView?.kind === 'terminal' ? nonBlank(tool.callView.command) : undefined)
		// Without a command the caption the call came with is the best name there is.
		if (command) {
			const row = commandRow(state, command, undefined)
			label = row.label
			tooltip = row.tooltip
		}
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
		body = undefined
		tooltip = tooltip ?? 'Details were not saved'
	}
	return {
		label,
		kind,
		...(lead ? { lead } : {}),
		...(file ? { file } : {}),
		...(main !== undefined && tail ? { main } : {}),
		...(tail ? { tail } : {}),
		...(stats ? { stats } : {}),
		...(body ? { body } : {}),
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
