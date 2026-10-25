import type {
	Message,
	SessionEvent,
	SessionRecord,
	ToolCall,
	ToolFacts,
	ToolPresenter,
} from '@namzu/sdk'

import {
	DEFAULT_AGENT_WORKFLOW,
	type SubagentActivity,
} from '../integrations/subagents/activity.js'
import { NARRATION_TOOL_NAME } from '../integrations/subagents/runtime.js'
import { isWorkflowRunAgent } from '../integrations/workflows/view.js'
import { settledWorkflows } from './AgentExplorer.js'
import { messageCollapses } from './Transcript.js'
import {
	agentDoneRows,
	agentMessageRow,
	agentNotice,
	launchReceipt,
	reportsAsNotification,
	settleLine,
	workflowNotice,
} from './agent-transcript-rows.js'
import { type AgentEvent, toAgentEvent } from './agent.js'
import { tokenColor } from './theme.js'
import { type ToolEndStart, type ToolRow, formatToolCall, toolEndRows } from './tool-end-rows.js'
import { describeTurnStop } from './turn-interruption.js'
import type { TranscriptMessage } from './types.js'
import { webCallTitle } from './web-activity.js'

/**
 * What a saved conversation shows of the work it did.
 *
 * The live run draws a tool call from the events the kernel emits as it runs.
 * The same events are journaled, so a resumed conversation replays them
 * through the same translation (`toAgentEvent`) and the same row builder
 * (`toolEndRows`) the live path calls: a change to how a read, an edit or a
 * command is drawn reaches both. A conversation saved without its journal (a
 * fork, an old log) is drawn from the saved messages alone, which keep every
 * call and its result but not the typed facts or timings.
 */

type Record_ = Readonly<Record<string, unknown>>

interface CallTrail {
	start?: Record_
	end?: Record_
}

interface TurnTrail {
	startedAt?: number
	endedAt?: number
	stopReason?: string
	cancelCause?: string
	budget?: unknown
	/** Launches of the `Agent` tool in this turn, and whether each failed. */
	agents: boolean[]
}

/** What the journal remembers about the calls and turns of one conversation. */
export interface RestoredTrail {
	readonly calls: ReadonlyMap<string, CallTrail>
	readonly turns: ReadonlyMap<string, TurnTrail>
	/** The turn each saved message was written in, by message id. */
	readonly turnOfMessage: ReadonlyMap<string, string>
}

const NO_TRAIL: RestoredTrail = {
	calls: new Map(),
	turns: new Map(),
	turnOfMessage: new Map(),
}

const callKey = (turnId: string | undefined, toolUseId: string): string =>
	`${turnId ?? ''}\u0000${toolUseId}`

function atOf(record: Record_): number | undefined {
	const at = typeof record.ts === 'string' ? Date.parse(record.ts) : Number.NaN
	return Number.isFinite(at) ? at : undefined
}

/** Index the journal's records for the tool calls, turns and messages a saved conversation shows. */
export function trailFromRecords(records: readonly SessionRecord[] | undefined): RestoredTrail {
	if (!records || records.length === 0) return NO_TRAIL
	const calls = new Map<string, CallTrail>()
	const turns = new Map<string, TurnTrail>()
	const turnOfMessage = new Map<string, string>()
	const turn = (id: string): TurnTrail => {
		let found = turns.get(id)
		if (!found) {
			found = { agents: [] }
			turns.set(id, found)
		}
		return found
	}
	for (const raw of records) {
		const record = raw as unknown as Record_
		const turnId = typeof record.turnId === 'string' ? record.turnId : undefined
		switch (record.type) {
			case 'message':
				if (turnId && typeof record.messageId === 'string')
					turnOfMessage.set(record.messageId, turnId)
				break
			case 'turn_started':
				if (turnId) turn(turnId).startedAt = atOf(record)
				break
			case 'turn_completed':
			case 'turn_failed':
				if (turnId) {
					const t = turn(turnId)
					t.endedAt = atOf(record)
					if (record.type === 'turn_completed') {
						if (typeof record.stopReason === 'string') t.stopReason = record.stopReason
						if (typeof record.cancelCause === 'string') t.cancelCause = record.cancelCause
						t.budget = record.budget
					} else {
						t.stopReason = 'failed'
					}
				}
				break
			case 'tool_executing': {
				if (typeof record.toolUseId !== 'string' || record.via) break
				const key = callKey(turnId, record.toolUseId)
				calls.set(key, { ...calls.get(key), start: record })
				if (turnId && String(record.toolName).toLowerCase() === 'agent')
					turn(turnId).agents.push(false)
				break
			}
			case 'tool_completed': {
				if (typeof record.toolUseId !== 'string' || record.via) break
				const key = callKey(turnId, record.toolUseId)
				calls.set(key, { ...calls.get(key), end: record })
				break
			}
			default:
				break
		}
	}
	// A launch that ended in an error counts as a failed agent in the closing line.
	for (const [key, call] of calls) {
		if (call.end?.isError !== true || String(call.end.toolName).toLowerCase() !== 'agent') continue
		const turnId = key.split('\u0000')[0]
		const agents = turnId ? turns.get(turnId)?.agents : undefined
		const index = agents?.indexOf(false) ?? -1
		if (agents && index >= 0) agents[index] = true
	}
	return { calls, turns, turnOfMessage }
}

function parseInput(call: ToolCall): unknown {
	try {
		return JSON.parse(call.function.arguments)
	} catch {
		return {}
	}
}

function resultText(message: Message | undefined): string {
	if (!message || message.role !== 'tool') return ''
	const content = message.content
	if (typeof content === 'string') return content
	return content
		.map((block) => (block.type === 'text' ? block.text : ''))
		.filter((text) => text.length > 0)
		.join('\n')
}

const EDIT_RECEIPT = /^Edited .+?: (\d+) replacements?\(?s?\)? \(\+(\d+) -(\d+)\)/u

const WRITE_RECEIPT =
	/^(Created|Updated|Unchanged|Wrote) .+?(?: \(\+(\d+) -(\d+)\))?(?: · final newline changed)? · \d+ bytes$/u

/**
 * What a call did, as far as a saved receipt says. The journal keeps the
 * kernel's own typed facts; a conversation without one (a fork, an older log)
 * has the call and the model's receipt, which is enough for the file a read,
 * an edit or a write named and, for a write, how it went.
 */
function factsFromReceipt(
	presenter: ToolPresenter,
	call: ToolCall,
	text: string,
	isError: boolean,
): ToolFacts | undefined {
	if (isError) return undefined
	const input = parseInput(call) as { path?: unknown }
	const view = presenter.presentCall(call.function.name, input)
	const name = call.function.name
	if (name === 'write' && typeof input.path === 'string') {
		const receipt = WRITE_RECEIPT.exec(text.split('\n')[0] ?? '')
		if (!receipt) return undefined
		const operation = { Created: 'created', Updated: 'updated', Unchanged: 'unchanged' }[
			receipt[1] as string
		] as 'created' | 'updated' | 'unchanged' | undefined
		return {
			kind: 'write',
			path: input.path,
			operation: operation ?? 'wrote',
			...(receipt[2] !== undefined ? { added: Number(receipt[2]) } : {}),
			...(receipt[3] !== undefined ? { removed: Number(receipt[3]) } : {}),
		}
	}
	if (name === 'edit' && typeof input.path === 'string') {
		const receipt = EDIT_RECEIPT.exec(text.split('\n')[0] ?? '')
		if (receipt) {
			return {
				kind: 'edit',
				path: input.path,
				replacements: Number(receipt[1]),
				added: Number(receipt[2]),
				removed: Number(receipt[3]),
			}
		}
	}
	// A command's output is read from its text; a call's facts hold no output.
	if (view.kind === 'generic') return view.facts?.kind === 'command' ? undefined : view.facts
	if (name === 'edit' && view.kind === 'diff' && view.path) return { kind: 'edit', path: view.path }
	return undefined
}

const INTERRUPTED_RESULT = 'Tool execution was interrupted and no durable result is available'

/** The call's start as the live row held it. */
function startOf(event: Extract<AgentEvent, { kind: 'tool-start' }>): ToolEndStart {
	return {
		label: event.web
			? webCallTitle(event.web)
			: formatToolCall(event.toolName, event.summary, event.standalone),
		...(event.detail ? { detail: event.detail } : {}),
		...(event.command ? { command: event.command } : {}),
		...(event.proposed ? { proposed: event.proposed } : {}),
		...(event.web ? { web: event.web } : {}),
		...(event.activity ? { activity: event.activity } : {}),
		...(event.fold ? { fold: event.fold } : {}),
	}
}

/** Rows a call that never reported a result leaves: named, and said to be interrupted. */
function interruptedRows(label: string): ToolRow[] {
	return [
		{ role: 'tool', content: label, glyph: '○', glyphColor: tokenColor('text.muted') },
		{ role: 'tool', content: 'Interrupted', glyph: '⎿' },
	]
}

/** The rows one saved tool call leaves, as the live run drew them. */
export function restoredToolRows(
	turnId: string | undefined,
	call: ToolCall,
	results: ReadonlyMap<string, Message>,
	trail: RestoredTrail,
	presenter: ToolPresenter,
	cwd?: string,
): readonly ToolRow[] {
	const toolName = call.function.name
	const saved = trail.calls.get(callKey(turnId, call.id))
	const sessionId = 'restored'
	const startRecord = (saved?.start ??
		({
			type: 'tool_executing',
			sessionId,
			turnId: turnId ?? 'restored',
			toolUseId: call.id,
			toolName,
			input: parseInput(call),
		} satisfies Record_)) as unknown as SessionEvent
	const started = toAgentEvent(startRecord, presenter, undefined, cwd)
	if (started?.kind !== 'tool-start') return []
	const message = results.get(call.id)
	const text = resultText(message)
	const interrupted = saved?.end === undefined && (!message || text.startsWith(INTERRUPTED_RESULT))
	const start = startOf(started)
	if (interrupted) return interruptedRows(start.label)
	const isError = message?.role === 'tool' && message.isError === true
	const facts = saved?.end ? undefined : factsFromReceipt(presenter, call, text, isError)
	const endRecord = (saved?.end ??
		({
			type: 'tool_completed',
			sessionId,
			turnId: turnId ?? 'restored',
			toolUseId: call.id,
			toolName,
			result: text,
			isError,
			...(facts ? { facts } : {}),
		} satisfies Record_)) as unknown as SessionEvent
	const ended = toAgentEvent(endRecord, presenter, undefined, cwd)
	if (ended?.kind !== 'tool-end') return []
	const name = toolName.toLowerCase()
	// Drawn by other surfaces in the live run: the rail and the agent rows own
	// a successful delegation, the band owns narration, the plan owns tasks.
	if (!ended.isError && (name === 'agent' || name === 'wait_for_task')) return []
	if (!ended.isError && toolName === NARRATION_TOOL_NAME) return []
	const built = toolEndRows(ended, start, {
		...(ended.durationMs !== undefined ? { elapsedMs: ended.durationMs } : {}),
		hasPlan: true,
		...(cwd ? { cwd } : {}),
	})
	return built.kind === 'rows' ? built.rows : []
}

/** Everything a projection needs beyond the messages. */
export interface RestoreOptions {
	readonly presenter: ToolPresenter
	readonly trail?: RestoredTrail
	/** The working folder, so paths read as they did live. */
	readonly cwd?: string
}

/**
 * The tool rows, closing line and interruption of the turn a message belongs
 * to, added around the messages the projection already draws.
 */
export interface RestoredTurnWriter {
	/**
	 * Rows for the tool calls an assistant message made, and the turn whose
	 * agents it launched (their rows are placed once the saved children are read).
	 */
	toolRows(message: Message): {
		readonly rows: readonly TranscriptMessage[]
		readonly launchedIn?: string
	}
	/** Called with the turn of each projected message; yields the previous turn's closing rows on a change. */
	enter(message: Message): readonly TranscriptMessage[]
	/** The closing rows of the last turn. */
	finish(): readonly TranscriptMessage[]
}

export function createRestoredTurnWriter(
	messages: readonly Message[],
	nextId: () => string,
	options: RestoreOptions,
): RestoredTurnWriter {
	const trail = options.trail ?? NO_TRAIL
	const results = new Map<string, Message>()
	for (const message of messages) {
		if (message.role === 'tool') results.set(message.toolCallId, message)
	}
	let current: string | undefined
	const closing = (turnId: string | undefined): readonly TranscriptMessage[] => {
		if (!turnId) return []
		const turn = trail.turns.get(turnId)
		if (!turn) return []
		const rows: TranscriptMessage[] = []
		if (turn.stopReason === 'cancelled' && turn.cancelCause === 'user') {
			rows.push({ id: nextId(), role: 'system', content: 'Interrupted.' })
			return rows
		}
		const notice = describeTurnStop(
			turn.stopReason === 'failed' ? undefined : (turn.stopReason as never),
			turn.budget as never,
		)
		if (notice) rows.push({ id: nextId(), role: 'system', content: notice, glyph: '■' })
		const completed = turn.stopReason === undefined || turn.stopReason === 'end_turn'
		if (turn.startedAt !== undefined && turn.endedAt !== undefined) {
			const stand = turn.agents.map(
				(failed) => ({ status: failed ? 'failed' : 'completed' }) as unknown as SubagentActivity,
			)
			const line =
				stand.length > 0 || completed
					? settleLine(Math.max(0, turn.endedAt - turn.startedAt), stand, new Date(turn.endedAt))
					: undefined
			if (line)
				rows.push({
					id: nextId(),
					role: 'system',
					content: line,
					glyph: '✻',
					glyphColor: tokenColor('text.muted'),
				})
		}
		return rows
	}
	return {
		toolRows(message) {
			if (message.role !== 'assistant' || !message.toolCalls?.length) return { rows: [] }
			const turnId = message.id ? trail.turnOfMessage.get(message.id) : undefined
			const rows: TranscriptMessage[] = []
			let launched = false
			for (const call of message.toolCalls) {
				if (call.function.name.toLowerCase() === 'agent') launched = true
				for (const row of restoredToolRows(
					turnId,
					call,
					results,
					trail,
					options.presenter,
					options.cwd,
				)) {
					rows.push({ id: nextId(), ...row })
				}
			}
			return { rows, ...(launched && turnId ? { launchedIn: turnId } : {}) }
		},
		enter(message) {
			const turnId = message.id ? trail.turnOfMessage.get(message.id) : undefined
			if (!turnId || turnId === current) return []
			const before = closing(current)
			current = turnId
			return before
		},
		finish() {
			const rows = closing(current)
			current = undefined
			return rows
		},
	}
}

/** Number the bodies Ctrl+O can open, in order, as `pushMessage` does for a live row. */
export function numberDetailRows(rows: readonly TranscriptMessage[]): readonly TranscriptMessage[] {
	let count = 0
	return rows.map((row) => {
		const expandable =
			row.role !== 'user' &&
			row.role !== 'assistant' &&
			((row.activity && row.detail?.length) ||
				messageCollapses({ detail: row.detail, shell: row.shell, diff: row.diff }))
		if (!expandable) {
			if (row.detailRef === undefined) return row
			const { detailRef: _dropped, ...rest } = row
			return rest
		}
		count += 1
		return row.detailRef === count ? row : { ...row, detailRef: count }
	})
}

function agentRowFor(row: ToolRow, nextId: () => string): TranscriptMessage {
	return { id: nextId(), ...row }
}

/** What an agent that ended leaves in the conversation, as the live run wrote it. */
export function agentCompletionRows(
	agent: SubagentActivity,
	/** The reason this agent's last failure notice gave: the same reason again reads `failed again`. */
	previousFailure?: string,
): readonly ToolRow[] {
	// A workflow's agents are read in its detail view; the workflow closes with one line.
	if (agent.workflow !== DEFAULT_AGENT_WORKFLOW) return []
	// An agent the parent waited on handed its result back inline: the line is
	// the tool's own result, not a notification.
	if (agent.status === 'completed' && !reportsAsNotification(agent)) {
		const done = agentDoneRows(agent)
		return [
			{ role: 'tool', content: done.header, glyph: '●', glyphColor: tokenColor('accent.assistant') },
			{ role: 'tool', content: done.result, glyph: '⎿', glyphColor: tokenColor('text.muted') },
		]
	}
	// One row per completion: the line that says it ended, carrying the agent's
	// answer as its expandable detail (Ctrl+O) instead of a second row.
	const said = agent.status === 'completed' ? agentMessageRow(agent) : undefined
	const notice = agentNotice(agent, Date.now(), previousFailure)
	return [
		{
			role: 'tool',
			content: notice.content,
			glyph: '●',
			glyphColor:
				notice.tone === 'ok'
					? tokenColor('status.ok')
					: notice.tone === 'error'
						? tokenColor('status.error')
						: tokenColor('status.warn'),
			// Only the glyph carries the outcome; the sentence is the primary text.
			contentColor: tokenColor('text.primary'),
			...(said ? { detail: said.detail, meta: said.hint, activity: 'agent-result' as const } : {}),
		},
	]
}

/** The launch receipt of one batch of agents. */
export function agentLaunchRow(members: readonly SubagentActivity[]): ToolRow {
	return {
		role: 'tool',
		content: launchReceipt(members).content,
		glyph: '●',
		glyphColor: tokenColor('accent.assistant'),
	}
}

/** The line a settled workflow leaves. */
export function workflowClosingRow(workflow: Parameters<typeof workflowNotice>[0]): ToolRow {
	const notice = workflowNotice(workflow)
	return {
		role: 'tool',
		content: notice.content,
		glyph: notice.glyph,
		glyphColor:
			notice.tone === 'error'
				? tokenColor('status.error')
				: notice.tone === 'warn'
					? tokenColor('status.warn')
					: tokenColor('text.muted'),
	}
}

/**
 * Place the rows of the agents a saved conversation launched, once its saved
 * children are known. A marker left by the projection says which turn's
 * agents go where; a marker whose agents are not (yet) known stays.
 */
export function withSavedAgentRows(
	rows: readonly TranscriptMessage[],
	agents: readonly SubagentActivity[],
	nextId: () => string,
): readonly TranscriptMessage[] {
	if (!rows.some((row) => row.agentTurnId !== undefined)) return rows
	let changed = false
	const out: TranscriptMessage[] = []
	for (const row of rows) {
		if (row.agentTurnId === undefined) {
			out.push(row)
			continue
		}
		const { agentTurnId: _marker, ...plain } = row
		const mine = agents.filter(
			(agent) => agent.workflowId === row.agentTurnId && !isWorkflowRunAgent(agent),
		)
		if (mine.length === 0) {
			out.push(row)
			continue
		}
		changed = true
		out.push(plain)
		const batches = new Map<string, SubagentActivity[]>()
		for (const agent of mine) {
			const members = batches.get(agent.batchId) ?? []
			members.push(agent)
			batches.set(agent.batchId, members)
		}
		for (const members of batches.values()) {
			const first = members[0]
			if (!first) continue
			if (first.workflow === DEFAULT_AGENT_WORKFLOW) {
				out.push(agentRowFor(agentLaunchRow(members), nextId))
			}
			for (const agent of members) {
				if (!['completed', 'failed', 'cancelled'].includes(agent.status)) continue
				for (const done of agentCompletionRows(agent)) out.push(agentRowFor(done, nextId))
			}
		}
		for (const workflow of settledWorkflows(mine)) {
			out.push(agentRowFor(workflowClosingRow(workflow), nextId))
		}
	}
	return changed ? numberDetailRows(out) : rows
}
