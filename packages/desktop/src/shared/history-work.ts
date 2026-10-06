import type { ToolCallView } from '@namzu/sdk'
import {
	type ThreadState,
	type TimelineEntry,
	type TurnState,
	restoreMessages,
} from './projection.js'
import type { ChatMessage } from './protocol.js'

/** Public display metadata from the same owned, strict journal snapshot as its messages. */
export interface HistoryMessageAnchor {
	index: number
	messageId: string
	turnId: string
	order: number
}
export interface HistoryTurn {
	turnId: string
	userMessageId: string
	order: number
	status: 'completed' | 'failed' | 'cancelled' | 'paused' | 'interrupted'
	/** A symbolic runtime classification, never provider/error/guardrail prose. */
	reason?: string
	/** Recorded runtime duration; not the desktop host's admission clock. */
	durationMs?: number
}
export interface HistoryTool {
	turnId: string
	toolUseId: string
	name: string
	order: number
	status: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'skipped'
	presentation?: ToolCallView
	durationMs?: number
	detailUnavailable?: true
}
export interface HistoryWorkSnapshot {
	v: 1
	partial: boolean
	messages: HistoryMessageAnchor[]
	turns: HistoryTurn[]
	tools: HistoryTool[]
}

const reasons = new Set([
	'end_turn',
	'stop_condition',
	'cancelled',
	'paused',
	'interrupted',
	'error',
	'token_budget',
	'cost_limit',
	'cost_unmeasurable',
	'timeout',
	'max_iterations',
	'plan_rejected',
	'step_refused',
	'structured_output_failed',
	'answer_rejected',
	'input_guardrail',
	'output_guardrail',
])
const bytes = (value: string) => new TextEncoder().encode(value).byteLength
const id = (value: unknown): value is string =>
	typeof value === 'string' &&
	value.length > 0 &&
	bytes(value) <= 512 &&
	[...value].every((char) => char.charCodeAt(0) >= 32)
const count = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const record = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** Copy only this closed public view; a journal extension must not leak extra fields. */
function publicView(value: unknown): ToolCallView | undefined {
	if (!record(value)) return undefined
	const optional = (key: string) => value[key] === undefined || typeof value[key] === 'string'
	let view: ToolCallView
	if (
		value.kind === 'generic' &&
		typeof value.label === 'string' &&
		(value.presentation === undefined || value.presentation === 'activity') &&
		(value.activity === undefined || value.activity === 'exploration') &&
		(value.visibility === undefined || value.visibility === 'hidden') &&
		(value.outcome === undefined || value.outcome === 'cancelled')
	) {
		view = {
			kind: 'generic',
			label: value.label,
			...(value.presentation === 'activity' ? { presentation: 'activity' } : {}),
			...(value.activity === 'exploration' ? { activity: 'exploration' } : {}),
			...(value.visibility === 'hidden' ? { visibility: 'hidden' } : {}),
			...(value.outcome === 'cancelled' ? { outcome: 'cancelled' } : {}),
		}
	} else if (
		value.kind === 'diff' &&
		typeof value.before === 'string' &&
		typeof value.after === 'string' &&
		optional('path') &&
		optional('label')
	) {
		view = {
			kind: 'diff',
			before: value.before,
			after: value.after,
			...(typeof value.path === 'string' ? { path: value.path } : {}),
			...(typeof value.label === 'string' ? { label: value.label } : {}),
		}
	} else if (value.kind === 'terminal' && typeof value.output === 'string' && optional('command')) {
		view = {
			kind: 'terminal',
			output: value.output,
			...(typeof value.command === 'string' ? { command: value.command } : {}),
		}
	} else return undefined
	return bytes(JSON.stringify(view)) <= 32 * 1024 ? view : undefined
}

/**
 * Restore display receipts only. Live projections win; no permission, retry,
 * reasoning body or execution authority is recovered from this snapshot.
 */
export function restoreHistoryWork(
	thread: ThreadState,
	messages: ChatMessage[],
	work?: HistoryWorkSnapshot,
): ThreadState {
	if (thread.running) return thread
	const restored = restoreMessages(thread, messages)
	if (
		!work ||
		work.v !== 1 ||
		typeof work.partial !== 'boolean' ||
		!Array.isArray(work.messages) ||
		!Array.isArray(work.turns) ||
		!Array.isArray(work.tools) ||
		work.messages.length > 200 ||
		work.turns.length > 200 ||
		work.tools.length > 100
	)
		return restored
	const turns = new Map<string, HistoryTurn>()
	for (const turn of work.turns) {
		if (
			!record(turn) ||
			!id(turn.turnId) ||
			!id(turn.userMessageId) ||
			!count(turn.order) ||
			!['completed', 'failed', 'cancelled', 'paused', 'interrupted'].includes(turn.status) ||
			turns.has(turn.turnId)
		)
			return restored
		turns.set(turn.turnId, turn)
	}
	const anchors = new Map<number, HistoryMessageAnchor>()
	const messageIds = new Set<string>()
	for (const anchor of work.messages) {
		if (
			!record(anchor) ||
			!count(anchor.index) ||
			!messages[anchor.index] ||
			!count(anchor.order) ||
			!id(anchor.messageId) ||
			!id(anchor.turnId) ||
			!turns.has(anchor.turnId) ||
			anchors.has(anchor.index) ||
			messageIds.has(anchor.messageId)
		)
			return restored
		anchors.set(anchor.index, anchor)
		messageIds.add(anchor.messageId)
	}
	for (const turn of turns.values()) {
		const prompt = [...anchors.values()].find((anchor) => anchor.messageId === turn.userMessageId)
		const own = [...anchors.values()]
			.filter((anchor) => anchor.turnId === turn.turnId)
			.sort((a, b) => a.index - b.index)
		if (
			!prompt ||
			prompt.turnId !== turn.turnId ||
			messages[prompt.index]?.role !== 'user' ||
			own[0] !== prompt ||
			own.some(
				(anchor, index) =>
					anchor.order <= turn.order ||
					(index > 0 && anchor.order <= (own[index - 1]?.order ?? Number.POSITIVE_INFINITY)),
			)
		)
			return restored
		if (
			own.some(
				(anchor, index) =>
					index > 0 &&
					[...anchors.values()].some(
						(other) =>
							other.index > (own[index - 1]?.index ?? Number.POSITIVE_INFINITY) &&
							other.index < anchor.index &&
							other.turnId !== turn.turnId,
					),
			)
		)
			return restored
		if (
			own.some((anchor, index) => {
				const previous = own[index - 1]
				return (
					previous &&
					messages.some(
						(message, rowIndex) =>
							rowIndex > previous.index &&
							rowIndex < anchor.index &&
							message.role === 'user' &&
							anchors.get(rowIndex)?.turnId !== turn.turnId,
					)
				)
			})
		)
			return restored
	}
	let nextTurn = 0
	let currentTurn = 0
	const numbered = new Map<string, number>()
	const timeline: TimelineEntry[] = messages.map((message, index) => {
		const anchor = anchors.get(index)
		if (anchor) {
			let turn = numbered.get(anchor.turnId)
			if (turn === undefined) {
				turn = ++nextTurn
				numbered.set(anchor.turnId, turn)
			}
			currentTurn = turn
		} else if (message.role === 'user') currentTurn = ++nextTurn
		return { kind: 'message', index, turn: currentTurn }
	})
	const toolEntries = new Map<number, TimelineEntry[]>()
	const tools: ThreadState['tools'] = {}
	let viewBytes = 0
	for (const tool of work.tools
		.filter((tool) => record(tool) && count(tool.order))
		.sort((a, b) => a.order - b.order)) {
		if (
			!record(tool) ||
			!id(tool.turnId) ||
			!id(tool.toolUseId) ||
			!id(tool.name) ||
			!tool.name.trim() ||
			bytes(tool.name) > 512 ||
			!count(tool.order) ||
			!['completed', 'failed', 'cancelled', 'interrupted', 'skipped'].includes(tool.status)
		)
			continue
		const turn = numbered.get(tool.turnId)
		const savedTurn = turns.get(tool.turnId)
		if (turn === undefined || !savedTurn || tool.order <= savedTurn.order) continue
		const key = `${turn}:${tool.toolUseId}`
		if (tools[key]) return restored
		let view =
			tool.status === 'skipped' || tool.status === 'interrupted'
				? undefined
				: publicView(tool.presentation)
		if (view?.kind === 'generic' && view.outcome === 'cancelled' && tool.status !== 'cancelled')
			view = undefined
		if (tool.status === 'cancelled' && !(view?.kind === 'generic' && view.outcome === 'cancelled'))
			view = undefined
		if (view) {
			const size = bytes(JSON.stringify(view))
			if (viewBytes + size > 128 * 1024) view = undefined
			else viewBytes += size
		}
		if (!view)
			view = {
				kind: 'generic',
				label: `${tool.status === 'skipped' ? 'Skipped action' : 'Saved action'}\nDetails were not recorded.`,
				presentation: 'activity',
				...(tool.status === 'cancelled' ? { outcome: 'cancelled' } : {}),
			}
		tools[key] = {
			kind: 'tool_call',
			toolCallId: tool.toolUseId,
			title: view.kind === 'generic' && !view.label.trim() ? 'Saved action' : tool.name,
			...(tool.status === 'skipped' ? { historicalStatus: 'skipped' as const } : {}),
			status:
				tool.status === 'interrupted'
					? 'pending'
					: tool.status === 'failed' || tool.status === 'cancelled'
						? 'failed'
						: 'completed',
			view,
			...(count(tool.durationMs) ? { durationMs: tool.durationMs } : {}),
		}
		const own = [...anchors.values()]
			.filter((anchor) => anchor.turnId === tool.turnId)
			.sort((a, b) => a.index - b.index)
		const later = own.find((anchor) => anchor.order > tool.order)
		const position = later?.index ?? Math.max(...own.map((anchor) => anchor.index)) + 1
		const entries = toolEntries.get(position) ?? []
		entries.push({ kind: 'tool', id: key, turn })
		toolEntries.set(position, entries)
	}
	const ordered: TimelineEntry[] = []
	for (let index = 0; index <= timeline.length; index++) {
		ordered.push(...(toolEntries.get(index) ?? []))
		const entry = timeline[index]
		if (entry) ordered.push(entry)
	}
	const turnStates: Record<number, TurnState> = {}
	for (const [turnId, turn] of numbered) {
		const saved = turns.get(turnId)
		if (!saved) continue
		const reason =
			saved.status === 'failed'
				? 'error'
				: saved.status === 'cancelled'
					? 'cancelled'
					: saved.status === 'paused'
						? 'paused'
						: saved.status === 'interrupted'
							? 'interrupted'
							: saved.reason && reasons.has(saved.reason)
								? saved.reason
								: undefined
		turnStates[turn] = {
			turnId,
			...(reason ? { stopReason: reason, reason } : {}),
			...(count(saved.durationMs) ? { recordedDurationMs: saved.durationMs } : {}),
		}
	}
	const last = turnStates[currentTurn]
	return {
		...restored,
		timeline: ordered,
		turn: currentTurn,
		turns: turnStates,
		tools,
		permissions: [],
		stopReason: last?.stopReason,
		reason: last?.reason,
		partial: restored.partial,
		historyWorkPartial: work.partial,
	}
}
