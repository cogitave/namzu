/** Scoped operator methods; ACP owns prompts, cancellation and review. */
import { lstat } from 'node:fs/promises'
import {
	type AcpSessionPromptParams,
	type AcpSessionPromptResult,
	type AssistantMessage,
	DiskTaskStore,
	type PalComputerInput,
	type SessionRecord,
	type ToolCallView,
	asSessionId,
	isEntityId,
	selectAssistantText,
} from '@namzu/sdk'
import {
	type CliSessionScope,
	archiveConversation,
	closeSessions,
	listRecent,
	loadConversationSnapshot,
	openSessionScope,
	openSessions,
	readConversationFacts,
} from '../integrations/sessions/store.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { isTrusted, isTrustedAtStateRoot, trustDir } from '../integrations/trust/store.js'
import {
	claimPalConversation,
	listPalConversations,
	palConversationBinding,
} from '../pals/conversations.js'
import { createDesktopPalCommunicationExtensions } from '../pals/desktop-communication.js'
import {
	cliPalComputerStatus,
	cliPalScreen,
	cliPalScreenStream,
	executeCliPalComputerInput,
	existingCliPalRuntime,
	getCliPalRuntime,
	returnCliPalComputerControl,
	startCliPalComputer,
	stopCliPalComputer,
	takeOverCliPalComputer,
} from '../pals/environment.js'
import { palPublicAssistantText } from '../pals/public-transcript.js'
import { createPal, deletePal, getPal, listPals, palAtWorkspace, updatePal } from '../pals/store.js'
import { canonicalProjectPath } from '../permissions/canonical-project.js'
import type { CliHarnessRuntime } from './acp-harness.js'
import type { CliAcpRuntime } from './acp.js'

function text(params: Record<string, unknown>, key: string, max = 400): string {
	const value = params[key]
	if (typeof value !== 'string' || !value.trim() || value.length > max)
		throw new Error(`Invalid ${key}.`)
	return value
}
function session(params: Record<string, unknown>): string {
	const value = text(params, 'sessionId')
	if (!isEntityId(value, 'session')) throw new Error('Invalid conversation id.')
	return value
}

/** Preserve only a phase proved by the selected, unchanged public text. */
function storedAssistantPhase(
	message: AssistantMessage,
): 'commentary' | 'final_answer' | undefined {
	const parts = message.textParts
	if (!parts?.length || typeof message.content !== 'string') return undefined
	if (selectAssistantText(parts) !== message.content) return undefined
	const finals = parts.filter((part) => part.phase === 'final_answer')
	const selected = finals.length ? finals : parts
	const phase = selected[0]?.phase
	return phase && selected.every((part) => part.phase === phase) ? phase : undefined
}

/** First recorded public-message boundary, bound to the folded message identity. */
function recordedMessageTimes(records: readonly SessionRecord[]) {
	const starts = new Map<string, { turnId: string; seq: number; at: number; ambiguous: boolean }>()
	const messages = new Map<
		string,
		{ turnId: string; role: 'user' | 'assistant'; seq: number; at: number; ambiguous: boolean }
	>()
	for (const record of records) {
		if (record.type !== 'message_started' && record.type !== 'message') continue
		const at = Date.parse(record.ts)
		if (!Number.isFinite(at) || at < 0) continue
		if (record.type === 'message_started') {
			const previous = starts.get(record.messageId)
			starts.set(record.messageId, {
				turnId: record.turnId,
				seq: previous?.seq ?? record.seq,
				at: previous?.at ?? at,
				ambiguous: Boolean(previous && (previous.ambiguous || previous.turnId !== record.turnId)),
			})
		} else if (record.role === 'user' || record.role === 'assistant') {
			const previous = messages.get(record.messageId)
			messages.set(record.messageId, {
				turnId: record.turnId,
				role: record.role,
				seq: previous?.seq ?? record.seq,
				at: previous?.at ?? at,
				ambiguous: Boolean(previous),
			})
		}
	}
	return (messageId: string | undefined, role: 'user' | 'assistant') => {
		if (!historyId(messageId)) return undefined
		const message = messages.get(messageId)
		if (!message || message.ambiguous || message.role !== role) return undefined
		const start = starts.get(messageId)
		return {
			at:
				start && !start.ambiguous && start.turnId === message.turnId && start.seq <= message.seq
					? start.at
					: message.at,
			source: 'journal' as const,
		}
	}
}

/** Only a durable completion for this exact, unchanged Pal reply can hide it. */
function cancelledPalReplies(records: readonly SessionRecord[]): ReadonlyMap<string, string> {
	const messages = new Map<string, { turnId: string; seq: number; ambiguous: boolean }>()
	const completions = new Map<
		string,
		{ turnId: string; seq: number; stopReason: string; content?: string }
	>()
	const replacements = new Map<string, number>()
	for (const record of records) {
		if (record.type === 'message' && record.role === 'assistant') {
			const previous = messages.get(record.messageId)
			messages.set(record.messageId, {
				turnId: record.turnId,
				seq: record.seq,
				ambiguous: Boolean(previous && (previous.ambiguous || previous.turnId !== record.turnId)),
			})
		} else if (record.type === 'message_completed') {
			completions.set(record.messageId, {
				turnId: record.turnId,
				seq: record.seq,
				stopReason: record.stopReason,
				...(record.content === undefined ? {} : { content: record.content }),
			})
		} else if (record.type === 'message_replaced') {
			replacements.set(record.targetMessageId, record.seq)
		}
	}
	const cancelled = new Map<string, string>()
	for (const [id, completion] of completions) {
		const message = messages.get(id)
		if (
			completion.stopReason === 'cancelled' &&
			typeof completion.content === 'string' &&
			message &&
			!message.ambiguous &&
			message.turnId === completion.turnId &&
			message.seq < completion.seq &&
			(replacements.get(id) ?? 0) < completion.seq
		)
			cancelled.set(id, completion.content)
	}
	return cancelled
}

interface CancelledReply {
	messageId: string
	turnId: string
	startSeq: number
	seq: number
	content: string
	phase?: 'commentary' | 'final_answer'
	time?: { at: number; source: 'journal' }
}

/**
 * Ordinary conversations: the partial answer of a stopped turn lives only on its
 * `message_completed` record (the SDK commits no `message` for it). Same guards as
 * `cancelledPalReplies`: one start in the same turn before the completion, no committed
 * message, no later replacement. `turnOf`/`seqOf` locate committed rows by turn and seq.
 */
function cancelledAssistantReplies(records: readonly SessionRecord[]) {
	const committed = new Map<string, { turnId: string; seq: number; ambiguous: boolean }>()
	const starts = new Map<string, { turnId: string; seq: number; ts: string; ambiguous: boolean }>()
	const completions = new Map<
		string,
		{
			turnId: string
			seq: number
			stopReason: string
			content?: string
			phase?: 'commentary' | 'final_answer'
			ambiguous: boolean
		}
	>()
	const replacements = new Map<string, number>()
	const promptTurns = new Map<string, string>()
	for (const record of records) {
		if (record.type === 'message') {
			const previous = committed.get(record.messageId)
			committed.set(record.messageId, {
				turnId: previous?.turnId ?? record.turnId,
				seq: previous?.seq ?? record.seq,
				ambiguous: Boolean(previous && (previous.ambiguous || previous.turnId !== record.turnId)),
			})
		} else if (record.type === 'turn_started') {
			promptTurns.set(record.userMessageId, record.turnId)
		} else if (record.type === 'message_started') {
			const previous = starts.get(record.messageId)
			starts.set(record.messageId, {
				turnId: previous?.turnId ?? record.turnId,
				seq: previous?.seq ?? record.seq,
				ts: previous?.ts ?? record.ts,
				ambiguous: Boolean(previous && (previous.ambiguous || previous.turnId !== record.turnId)),
			})
		} else if (record.type === 'message_completed') {
			const previous = completions.get(record.messageId)
			const phase = record.textParts?.at(-1)?.phase
			completions.set(record.messageId, {
				turnId: record.turnId,
				seq: record.seq,
				stopReason: record.stopReason,
				...(record.content === undefined ? {} : { content: record.content }),
				...(phase === 'commentary' || phase === 'final_answer' ? { phase } : {}),
				ambiguous: Boolean(previous && (previous.ambiguous || previous.turnId !== record.turnId)),
			})
		} else if (record.type === 'message_replaced') {
			replacements.set(record.targetMessageId, record.seq)
		}
	}
	const replies: CancelledReply[] = []
	for (const [id, completion] of completions) {
		const start = starts.get(id)
		if (
			completion.stopReason !== 'cancelled' ||
			completion.ambiguous ||
			typeof completion.content !== 'string' ||
			!completion.content.trim() ||
			!historyId(id) ||
			committed.has(id) ||
			!start ||
			start.ambiguous ||
			start.turnId !== completion.turnId ||
			start.seq >= completion.seq ||
			(replacements.get(id) ?? 0) > completion.seq
		)
			continue
		const at = Date.parse(start.ts)
		replies.push({
			messageId: id,
			turnId: completion.turnId,
			startSeq: start.seq,
			seq: completion.seq,
			content: completion.content,
			...(completion.phase ? { phase: completion.phase } : {}),
			...(Number.isFinite(at) && at >= 0 ? { time: { at, source: 'journal' as const } } : {}),
		})
	}
	replies.sort((a, b) => a.seq - b.seq)
	const turnOf = (messageId: string | undefined) => {
		if (!messageId) return undefined
		const message = committed.get(messageId)
		return message && !message.ambiguous ? message.turnId : promptTurns.get(messageId)
	}
	const seqOf = (messageId: string | undefined) =>
		messageId ? committed.get(messageId)?.seq : undefined
	return { replies, turnOf, seqOf }
}

// Additive display-only history wire. Keep this closed shape aligned with Desktop
// shared/history-work.ts; it carries no execution, permission or recovery authority.
interface HistoryTurnView {
	turnId: string
	userMessageId: string
	order: number
	status: 'completed' | 'failed' | 'cancelled' | 'paused' | 'interrupted'
	reason?: string
	durationMs?: number
	startedAt?: number
	endedAt?: number
}
interface HistoryToolView {
	turnId: string
	toolUseId: string
	name: string
	order: number
	status: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'skipped'
	presentation?: ToolCallView
	durationMs?: number
	detailUnavailable?: true
	hosted?: true
	startedAt?: number
	endedAt?: number
}
const historyReasons = new Set([
	'end_turn',
	'stop_condition',
	'cancelled',
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
const historyCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const recordedAt = (record: SessionRecord): number | undefined => {
	const at = Date.parse(record.ts)
	return Number.isFinite(at) && at >= 0 ? at : undefined
}
const historyId = (value: unknown): value is string =>
	typeof value === 'string' &&
	value.length > 0 &&
	Buffer.byteLength(value) <= 512 &&
	[...value].every((char) => char.charCodeAt(0) >= 32)

interface HostedHistoryActivity {
	id: string
	status: 'running' | 'completed' | 'failed'
	query?: string
	url?: string
	results?: number
}

function hostedHistoryActivity(value: unknown): HostedHistoryActivity | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const data = value as Record<string, unknown>
	if (
		data.name !== 'web_search' ||
		!historyId(data.id) ||
		typeof data.status !== 'string' ||
		!['running', 'completed', 'failed'].includes(data.status) ||
		(data.query !== undefined &&
			(typeof data.query !== 'string' || Buffer.byteLength(data.query) > 4096)) ||
		(data.url !== undefined &&
			(typeof data.url !== 'string' || Buffer.byteLength(data.url) > 4096)) ||
		(data.results !== undefined && !historyCount(data.results))
	)
		return undefined
	return {
		id: data.id,
		status: data.status as HostedHistoryActivity['status'],
		...(typeof data.query === 'string' ? { query: data.query } : {}),
		...(typeof data.url === 'string' ? { url: data.url } : {}),
		...(typeof data.results === 'number' ? { results: data.results } : {}),
	}
}

function hostedHistoryView(activity: HostedHistoryActivity): ToolCallView {
	const page = Boolean(activity.url && !activity.query)
	const title = page ? 'Web fetch' : 'Web search'
	const target = (page ? activity.url : activity.query)?.replace(/\s+/g, ' ').trim()
	return {
		kind: 'generic',
		label: `${title}${target ? `: ${target.slice(0, 200)}` : ''}${
			activity.status === 'failed'
				? ' failed'
				: !page && activity.results !== undefined
					? ` · ${activity.results} ${activity.results === 1 ? 'source' : 'sources'}`
					: ''
		}`,
		presentation: 'activity',
	}
}

/** A recorded public view is distinct from raw arguments and selected tool output. */
function historyPresentation(value: unknown): ToolCallView | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const data = value as Record<string, unknown>
	const optional = (key: string) => data[key] === undefined || typeof data[key] === 'string'
	let view: ToolCallView
	if (
		data.kind === 'generic' &&
		typeof data.label === 'string' &&
		(data.presentation === undefined || data.presentation === 'activity') &&
		(data.activity === undefined || data.activity === 'exploration') &&
		(data.visibility === undefined || data.visibility === 'hidden') &&
		(data.outcome === undefined || data.outcome === 'cancelled')
	) {
		view = {
			kind: 'generic',
			label: data.label,
			...(data.presentation === 'activity' ? { presentation: 'activity' } : {}),
			...(data.activity === 'exploration' ? { activity: 'exploration' } : {}),
			...(data.visibility === 'hidden' ? { visibility: 'hidden' } : {}),
			...(data.outcome === 'cancelled' ? { outcome: 'cancelled' } : {}),
		}
	} else if (
		data.kind === 'diff' &&
		typeof data.before === 'string' &&
		typeof data.after === 'string' &&
		optional('path') &&
		optional('label')
	) {
		view = {
			kind: 'diff',
			before: data.before,
			after: data.after,
			...(typeof data.path === 'string' ? { path: data.path } : {}),
			...(typeof data.label === 'string' ? { label: data.label } : {}),
		}
	} else if (data.kind === 'terminal' && typeof data.output === 'string' && optional('command')) {
		view = {
			kind: 'terminal',
			output: data.output,
			...(typeof data.command === 'string' ? { command: data.command } : {}),
		}
	} else return undefined
	return Buffer.byteLength(JSON.stringify(view)) <= 32 * 1024 ? view : undefined
}

function historyWork(
	records: readonly SessionRecord[],
	rows: readonly { messageId?: string; role: 'user' | 'assistant' }[],
) {
	const retainedIds = new Set(rows.flatMap((row) => (row.messageId ? [row.messageId] : [])))
	const owners = new Map<
		string,
		{ turnId: string; role: string; order: number; ambiguous: boolean }
	>()
	const starts = new Map<string, { turnId: string; order: number; ambiguous: boolean }>()
	const turns = new Map<string, HistoryTurnView>()
	const ambiguousTurns = new Set<string>()
	for (const record of records) {
		if (record.type === 'turn_started' && retainedIds.has(record.userMessageId)) {
			if (turns.has(record.turnId)) ambiguousTurns.add(record.turnId)
			turns.set(record.turnId, {
				turnId: record.turnId,
				userMessageId: record.userMessageId,
				order: record.seq,
				status: 'interrupted',
				reason: 'interrupted',
				...(recordedAt(record) === undefined ? {} : { startedAt: recordedAt(record) }),
			})
		} else if (record.type === 'message_started' && retainedIds.has(record.messageId)) {
			const previous = starts.get(record.messageId)
			starts.set(record.messageId, {
				turnId: record.turnId,
				order: previous?.order ?? record.seq,
				ambiguous: Boolean(previous && (previous.ambiguous || previous.turnId !== record.turnId)),
			})
		} else if (record.type === 'message' && retainedIds.has(record.messageId)) {
			const previous = owners.get(record.messageId)
			const start = starts.get(record.messageId)
			owners.set(record.messageId, {
				turnId: record.turnId,
				role: record.role,
				order:
					previous?.order ??
					(start && !start.ambiguous && start.turnId === record.turnId ? start.order : record.seq),
				ambiguous: Boolean(
					previous &&
						(previous.ambiguous ||
							previous.turnId !== record.turnId ||
							previous.role !== record.role),
				),
			})
		} else if ('turnId' in record && typeof record.turnId === 'string') {
			const turn = turns.get(record.turnId)
			if (!turn) continue
			if (record.type === 'turn_paused') {
				turn.status = 'paused'
				turn.reason = 'paused'
			} else if (record.type === 'turn_resuming') {
				turn.status = 'interrupted'
				turn.reason = 'interrupted'
			} else if (record.type === 'turn_failed') {
				turn.status = 'failed'
				turn.reason = 'error'
				turn.durationMs = record.settlement.durationMs
				turn.endedAt = recordedAt(record)
			} else if (record.type === 'turn_completed') {
				turn.status = record.settlement.status === 'cancelled' ? 'cancelled' : 'completed'
				turn.reason =
					record.settlement.status === 'cancelled'
						? 'cancelled'
						: record.stopReason && historyReasons.has(record.stopReason)
							? record.stopReason
							: undefined
				turn.durationMs = record.settlement.durationMs
				turn.endedAt = recordedAt(record)
			}
		}
	}
	const anchors = rows.flatMap((row, index) => {
		const owner = row.messageId && owners.get(row.messageId)
		return owner &&
			!owner.ambiguous &&
			owner.role === row.role &&
			historyId(row.messageId) &&
			historyId(owner.turnId)
			? [{ index, messageId: row.messageId, turnId: owner.turnId, order: owner.order }]
			: []
	})
	const selectedTurns = [...turns.values()]
		.filter((turn) => {
			const prompt = anchors.find(
				(anchor) =>
					anchor.messageId === turn.userMessageId &&
					anchor.turnId === turn.turnId &&
					rows[anchor.index]?.role === 'user',
			)
			const own = anchors.filter((anchor) => anchor.turnId === turn.turnId)
			// Compaction can retain/reorder old bodies. Ambiguous order supplies no work anchor.
			return (
				!ambiguousTurns.has(turn.turnId) &&
				prompt &&
				own[0] === prompt &&
				own.every(
					(anchor, index) =>
						anchor.order > turn.order &&
						(index === 0 || anchor.order > (own[index - 1]?.order ?? Number.POSITIVE_INFINITY)),
				) &&
				own.every((anchor, index) => {
					const previous = own[index - 1]
					return (
						!previous ||
						rows.every(
							(row, rowIndex) =>
								rowIndex <= previous.index ||
								rowIndex >= anchor.index ||
								row.role !== 'user' ||
								anchors.some((other) => other.index === rowIndex && other.turnId === turn.turnId),
						)
					)
				}) &&
				own.every(
					(anchor, index) =>
						index === 0 ||
						!anchors.some(
							(other) =>
								other.index > (own[index - 1]?.index ?? Number.POSITIVE_INFINITY) &&
								other.index < anchor.index &&
								other.turnId !== turn.turnId,
						),
				)
			)
		})
		.slice(-200)
	const accepted = new Set(selectedTurns.map((turn) => turn.turnId))
	let partial = false
	// Select only a bounded set of latest identities before collecting their boundaries.
	const wanted = new Set<string>()
	const hostedWanted = new Set<string>()
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index]
		if (!record) continue
		if (typeof record.turnId !== 'string' || !accepted.has(record.turnId)) continue
		let key: string
		let selected: Set<string>
		if (record.type === 'tool_executing' || record.type === 'tool_completed') {
			if (!historyId(record.toolUseId)) {
				partial = true
				continue
			}
			key = JSON.stringify([record.turnId, record.toolUseId])
			selected = wanted
		} else if (record.type === 'hosted_tool') {
			const hosted = hostedHistoryActivity(record.tool)
			if (!hosted || !historyCount(record.iteration)) {
				partial = true
				continue
			}
			key = JSON.stringify([record.turnId, record.iteration, hosted.id])
			selected = hostedWanted
		} else continue
		if (selected.has(key)) continue
		if (wanted.size + hostedWanted.size >= 100) {
			partial = true
			break
		}
		selected.add(key)
	}
	const calls = new Map<
		string,
		{
			firstOrder: number
			startedAt?: number
			name: string
			ambiguous: boolean
			latest: Extract<SessionRecord, { type: 'tool_executing' | 'tool_completed' }>
		}
	>()
	for (const record of records) {
		if (record.type !== 'tool_executing' && record.type !== 'tool_completed') continue
		const key = JSON.stringify([record.turnId, record.toolUseId])
		if (!wanted.has(key)) continue
		const previous = calls.get(key)
		calls.set(key, {
			firstOrder: previous?.firstOrder ?? record.seq,
			startedAt:
				previous?.startedAt ?? (record.type === 'tool_executing' ? recordedAt(record) : undefined),
			name: record.toolName,
			ambiguous: Boolean(previous && (previous.ambiguous || previous.name !== record.toolName)),
			latest: record,
		})
	}
	const compacted = records.filter((record) => record.type === 'compaction')
	let presentationBytes = 0
	const tools: HistoryToolView[] = []
	for (const call of [...calls.values()].sort((a, b) => a.firstOrder - b.firstOrder)) {
		const latest = call.latest
		const turn = turns.get(latest.turnId)
		if (
			call.ambiguous ||
			!historyId(call.name) ||
			!turn ||
			call.firstOrder <= turn.order ||
			compacted.some((record) => call.firstOrder <= record.replacesSeqRange[1])
		) {
			partial = true
			continue
		}
		let status: HistoryToolView['status'] = 'interrupted'
		let presentation: ToolCallView | undefined
		let durationMs: number | undefined
		if (
			latest.type === 'tool_completed' &&
			typeof latest.isError === 'boolean' &&
			typeof latest.result === 'string'
		) {
			status = latest.skipped === true ? 'skipped' : latest.isError ? 'failed' : 'completed'
			if (
				latest.skipped === undefined &&
				(latest.outputTruncated === undefined || latest.outputTruncated === false)
			)
				presentation = historyPresentation(latest.presentation)
			if (presentation?.kind === 'generic' && presentation.outcome === 'cancelled') {
				if (latest.isError) status = 'cancelled'
				else presentation = undefined
			}
			if (presentation) {
				const size = Buffer.byteLength(JSON.stringify(presentation))
				if (presentationBytes + size > 128 * 1024) presentation = undefined
				else presentationBytes += size
			}
			if (historyCount(latest.durationMs)) durationMs = latest.durationMs
		}
		if (!presentation) partial = true
		tools.push({
			turnId: latest.turnId,
			toolUseId: latest.toolUseId,
			name: call.name,
			order: call.firstOrder,
			status,
			...(presentation ? { presentation } : { detailUnavailable: true as const }),
			...(durationMs === undefined ? {} : { durationMs }),
			...(call.startedAt === undefined ? {} : { startedAt: call.startedAt }),
			...(latest.type !== 'tool_completed' || recordedAt(latest) === undefined
				? {}
				: { endedAt: recordedAt(latest) }),
		})
	}
	const hostedCalls = new Map<
		string,
		{
			turnId: string
			firstOrder: number
			toolUseId: string
			activity: HostedHistoryActivity
			startedAt?: number
			endedAt?: number
			ambiguous: boolean
		}
	>()
	for (const record of records) {
		if (record.type !== 'hosted_tool' || !accepted.has(record.turnId)) continue
		const hosted = hostedHistoryActivity(record.tool)
		if (!hosted || !historyCount(record.iteration)) continue
		const key = JSON.stringify([record.turnId, record.iteration, hosted.id])
		if (!hostedWanted.has(key)) continue
		const previous = hostedCalls.get(key)
		hostedCalls.set(key, {
			turnId: record.turnId,
			firstOrder: previous?.firstOrder ?? record.seq,
			toolUseId: `provider-hosted-web-search:${record.iteration}:${hosted.id}`,
			activity: {
				...hosted,
				...(hosted.query === undefined && previous?.activity.query
					? { query: previous.activity.query }
					: {}),
				...(hosted.url === undefined && previous?.activity.url
					? { url: previous.activity.url }
					: {}),
			},
			startedAt:
				previous?.startedAt ?? (hosted.status === 'running' ? recordedAt(record) : undefined),
			endedAt: hosted.status === 'running' ? previous?.endedAt : recordedAt(record),
			ambiguous: Boolean(
				previous &&
					(previous.ambiguous || (previous.endedAt !== undefined && hosted.status === 'running')),
			),
		})
	}
	for (const call of hostedCalls.values()) {
		const turn = turns.get(call.turnId)
		if (
			call.ambiguous ||
			!turn ||
			call.firstOrder <= turn.order ||
			compacted.some((record) => call.firstOrder <= record.replacesSeqRange[1]) ||
			tools.some((tool) => tool.turnId === call.turnId && tool.toolUseId === call.toolUseId)
		) {
			partial = true
			continue
		}
		const activity = call.activity
		const status = activity.status === 'running' ? 'interrupted' : activity.status
		tools.push({
			turnId: call.turnId,
			toolUseId: call.toolUseId,
			name: activity.url && !activity.query ? 'Web fetch' : 'Web search',
			order: call.firstOrder,
			status,
			hosted: true,
			...(status === 'interrupted'
				? { detailUnavailable: true as const }
				: { presentation: hostedHistoryView(activity) }),
			...(call.startedAt === undefined ? {} : { startedAt: call.startedAt }),
			...(call.endedAt === undefined ? {} : { endedAt: call.endedAt }),
		})
	}
	tools.sort((a, b) => a.order - b.order)
	return {
		v: 1 as const,
		partial,
		messages: anchors.filter((anchor) => accepted.has(anchor.turnId)),
		turns: selectedTurns,
		tools,
	}
}

export function createDesktopHostExtensions(
	runtime: CliAcpRuntime,
	directory: string,
	publishedSessionCwd?: (sessionId: string) => string | undefined,
	retrySession?: (
		sessionId: string,
		turnId: string,
		checkpointId: string,
		options?: AcpSessionPromptParams['options'],
	) => Promise<AcpSessionPromptResult>,
) {
	const cwd = canonicalProjectPath(directory)
	const pal = () => palAtWorkspace(cwd)
	const withState = async <T>(
		run: (state: Awaited<ReturnType<typeof openSessions>>) => Promise<T>,
	): Promise<T> => {
		if (!isTrusted(cwd)) throw new Error('Trust this folder before opening its conversations.')
		const state = await openSessions(cwd)
		try {
			return await run(state)
		} finally {
			closeSessions(state)
		}
	}
	const withReadScope = async <T>(run: (state: CliSessionScope) => Promise<T>): Promise<T> => {
		const root = resolveNamzuHome()
		if (!isTrustedAtStateRoot(cwd, root))
			throw new Error('Trust this folder before opening its conversations.')
		const scope = await openSessionScope(cwd, { stateRoot: root })
		if (!isTrustedAtStateRoot(cwd, scope.root))
			throw new Error('Trust this folder before opening its conversations.')
		return await run(scope)
	}
	const ownedSessionIn = async (params: Record<string, unknown>, state: CliSessionScope) => {
		const id = session(params)
		const durable = Boolean(await state.store.getSession(asSessionId(id), state.tenantId))
		const currentPal = palAtWorkspace(cwd, state.root)
		if (!durable) {
			// New ordinary ACP sessions have no journal until their first turn.
			// Only a published slot on this connection can authorize preparation;
			// a client-supplied UUID or another workspace is never sufficient.
			let publishedHere = false
			const publishedCwd = publishedSessionCwd?.(id)
			if (!currentPal && publishedCwd !== undefined) {
				try {
					publishedHere = canonicalProjectPath(publishedCwd) === cwd
				} catch {
					/* A missing or redirected workspace grants no transient ownership. */
				}
			}
			if (!publishedHere) throw new Error('This conversation does not belong to this project.')
		}
		if (currentPal) {
			const binding = await palConversationBinding(cwd, id, state)
			if (!binding || binding.pal.id !== currentPal.id)
				throw new Error('This conversation is not claimed by this Pal.')
		}
		return id
	}
	const ownedSession = (params: Record<string, unknown>) =>
		withState((state) => ownedSessionIn(params, state))
	const ownedReadSession = (params: Record<string, unknown>) =>
		withReadScope((state) => ownedSessionIn(params, state))
	const ownedPal = (params: Record<string, unknown>) => {
		const id = text(params, 'palId')
		if (!isTrusted(cwd) || pal()?.id !== id)
			throw new Error('This Pal does not own the current workspace.')
		return id
	}
	const retryStatus = runtime.providerRetryStatus?.bind(runtime)
	const liveInputStatus = runtime.liveInputStatus?.bind(runtime)
	const liveInput = runtime.liveInput?.bind(runtime)
	const liveOwner = async (params: Record<string, unknown>, state: CliSessionScope) => {
		const id = await ownedSessionIn(params, state)
		const publishedCwd = publishedSessionCwd?.(id)
		if (
			publishedCwd === undefined ||
			canonicalProjectPath(publishedCwd) !== cwd ||
			palAtWorkspace(cwd, state.root) ||
			resolveNamzuHome() !== state.root ||
			!isTrustedAtStateRoot(cwd, state.root)
		)
			throw new Error('Live input requires this connection’s owned ordinary conversation.')
		return id
	}
	return {
		...(liveInputStatus && liveInput && publishedSessionCwd
			? {
					'namzu/conversations/input/status': async (params: Record<string, unknown>) => {
						if (Object.keys(params).some((key) => !['sessionId', 'scopeId'].includes(key)))
							throw new Error('Live input status accepts only sessionId and scopeId.')
						const scopeId = params.scopeId === undefined ? undefined : text(params, 'scopeId')
						return withReadScope(async (state) =>
							liveInputStatus(await liveOwner(params, state), scopeId, state),
						)
					},
					'namzu/conversations/input': async (params: Record<string, unknown>) => {
						if (
							Object.keys(params).some(
								(key) => !['sessionId', 'scopeId', 'inputId', 'prompt'].includes(key),
							)
						)
							throw new Error('Live input accepts only sessionId, scopeId, inputId and prompt.')
						const input = {
							scopeId: text(params, 'scopeId'),
							inputId: text(params, 'inputId'),
							prompt: text(params, 'prompt', 1_000_000),
						}
						return withReadScope(async (state) =>
							liveInput(await liveOwner(params, state), input, state),
						)
					},
				}
			: {}),
		...(retryStatus && retrySession
			? {
					'namzu/sessions/retry-status': async (params: Record<string, unknown>) =>
						withReadScope(async (state) =>
							retryStatus(await ownedSessionIn(params, state), cwd, state),
						),
					'namzu/sessions/retry': async (params: Record<string, unknown>) => {
						if (
							Object.keys(params).some(
								(key) => !['sessionId', 'turnId', 'checkpointId', 'options'].includes(key),
							)
						)
							throw new Error(
								'Retry accepts only the original turn, checkpoint and explicit settings; send a new message after the turn settles.',
							)
						const id = await ownedSession(params)
						const turnId = text(params, 'turnId')
						const checkpointId = text(params, 'checkpointId')
						if (!isEntityId(turnId, 'turn') || !isEntityId(checkpointId, 'checkpoint'))
							throw new Error('Invalid retry turn or checkpoint.')
						return retrySession(
							id,
							turnId,
							checkpointId,
							params.options as AcpSessionPromptParams['options'],
						)
					},
				}
			: {}),
		'namzu/harnesses/list': async (params: Record<string, unknown>) => {
			if (pal())
				return {
					selected: 'namzu',
					locked: true,
					engines: [{ id: 'namzu', label: 'Namzu', available: true }],
				}
			const id = params.sessionId === undefined ? undefined : await ownedReadSession(params)
			const harness = runtime as Partial<CliHarnessRuntime>
			return harness.harnesses
				? harness.harnesses(id)
				: {
						selected: 'namzu',
						locked: false,
						engines: [{ id: 'namzu', label: 'Namzu', available: true }],
					}
		},
		'namzu/harnesses/select': async (params: Record<string, unknown>) => {
			if (pal()) throw new Error('External engines are available in normal conversations only.')
			const harness = runtime as Partial<CliHarnessRuntime>
			if (!harness.selectHarness) throw new Error('Update Namzu to use external engines.')
			return harness.selectHarness(await ownedSession(params), text(params, 'engine'))
		},
		'namzu/project/status': () => ({
			cwd,
			trusted: isTrusted(cwd),
			...(pal() ? { pal: pal() } : {}),
		}),
		...createDesktopPalCommunicationExtensions({ cwd, withState }),
		'namzu/pals/list': () => listPals(),
		'namzu/pals/get': (params: Record<string, unknown>) => getPal(text(params, 'id')),
		'namzu/pals/create': (params: Record<string, unknown>) =>
			createPal({
				name: text(params, 'name', 80),
				...(params.purpose === undefined ? {} : { purpose: params.purpose as string }),
				...(params.model === undefined ? {} : { model: params.model as never }),
				...(params.appearance === undefined ? {} : { appearance: params.appearance as never }),
			}),
		'namzu/pals/update': async (params: Record<string, unknown>) => {
			if (!Number.isSafeInteger(params.expectedRevision) || (params.expectedRevision as number) < 1)
				throw new Error('Invalid Pal revision.')
			const id = text(params, 'id')
			if (pal()?.id === id && (await getCliPalRuntime()).busy(id))
				throw new Error('Stop this Pal’s active work before changing it.')
			return updatePal(id, params.expectedRevision as number, {
				...(params.name === undefined ? {} : { name: params.name as string }),
				...(params.purpose === undefined ? {} : { purpose: params.purpose as string }),
				...(params.model === undefined ? {} : { model: params.model as never }),
				...(params.appearance === undefined ? {} : { appearance: params.appearance as never }),
				...(params.paused === undefined ? {} : { paused: params.paused as boolean }),
			})
		},
		'namzu/pals/delete': async (params: Record<string, unknown>) => {
			if (
				!params ||
				typeof params !== 'object' ||
				Array.isArray(params) ||
				Object.keys(params).some((key) => key !== 'id' && key !== 'expectedRevision')
			)
				throw new Error('Invalid Pal deletion request.')
			const id = text(params, 'id')
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id))
				throw new Error('Invalid Pal id.')
			const expectedRevision = params.expectedRevision as number
			if (
				!Number.isSafeInteger(expectedRevision) ||
				expectedRevision < 1 ||
				!Number.isSafeInteger(expectedRevision + 1)
			)
				throw new Error('Invalid Pal revision.')
			const home = resolveNamzuHome()
			const active = await existingCliPalRuntime()
			const currentPal = palAtWorkspace(cwd, home)
			if (currentPal && currentPal.id !== id)
				throw new Error('This Pal does not own the current workspace.')
			if (active && (active.busy(id) || active.computer(id)))
				throw new Error('Stop this Pal’s active work and computer before deleting it.')
			deletePal(id, expectedRevision, home)
			return { id, deleted: true as const }
		},
		'namzu/pals/computer/status': (params: Record<string, unknown>) =>
			cliPalComputerStatus(ownedPal(params)),
		'namzu/pals/computer/start': (params: Record<string, unknown>) =>
			startCliPalComputer(ownedPal(params)),
		'namzu/pals/computer/stop': (params: Record<string, unknown>) =>
			stopCliPalComputer(ownedPal(params)),
		'namzu/pals/computer/screen': (params: Record<string, unknown>) =>
			cliPalScreen(
				ownedPal(params),
				params.generation === undefined ? undefined : text(params, 'generation', 16),
			),
		'namzu/pals/computer/stream': (params: Record<string, unknown>) =>
			cliPalScreenStream(ownedPal(params), text(params, 'generation', 16)),
		'namzu/pals/computer/take_over': (params: Record<string, unknown>) =>
			takeOverCliPalComputer(ownedPal(params), text(params, 'generation', 16)),
		'namzu/pals/computer/return_control': (params: Record<string, unknown>) =>
			returnCliPalComputerControl(ownedPal(params), text(params, 'generation', 16)),
		'namzu/pals/computer/input': (params: Record<string, unknown>) =>
			executeCliPalComputerInput(
				ownedPal(params),
				text(params, 'generation', 16),
				params.input as PalComputerInput,
			),
		'namzu/pals/conversations/claim': async (params: Record<string, unknown>) => {
			if (!isTrusted(cwd)) throw new Error('This Pal workspace is not trusted.')
			return claimPalConversation(cwd, text(params, 'palId'), session(params))
		},
		'namzu/pals/conversations/list': (params: Record<string, unknown>) =>
			listPalConversations(cwd, text(params, 'palId')),
		'namzu/project/trust': (params: Record<string, unknown>) => {
			if (params.confirmed !== true || text(params, 'cwd', 32768) !== cwd)
				throw new Error('Folder confirmation does not match this project.')
			trustDir(cwd)
			return { cwd, trusted: true }
		},
		'namzu/conversations/list': () =>
			withState(async (state) => {
				const currentPal = pal()
				if (currentPal) return listPalConversations(cwd, currentPal.id)
				return Promise.all(
					(await listRecent(state, 100)).map(async (row) => {
						const engine = (await readConversationFacts(state, row.id))?.started.harness?.engineId
						return {
							...row,
							...(engine === 'codex'
								? { harness: 'codex-cli' }
								: engine === 'claude'
									? { harness: 'claude-code' }
									: {}),
						}
					}),
				)
			}),
		'namzu/conversations/history': async (params: Record<string, unknown>) => {
			return withReadScope(async (state) => {
				const id = await ownedSessionIn(params, state)
				const ownedPal = Boolean(palAtWorkspace(cwd, state.root))
				const snapshot = await loadConversationSnapshot(state, asSessionId(id))
				const messages = snapshot.messages
				const cancelled = ownedPal ? cancelledPalReplies(snapshot.records) : undefined
				const messageTime = recordedMessageTimes(snapshot.records)
				const shown = messages.flatMap<{
					messageId?: string
					role: 'user' | 'assistant'
					content: string | null
					phase?: 'commentary' | 'final_answer'
					time?: { at: number; source: 'journal' }
					stopReason?: 'cancelled'
					turnId?: string
					seq?: number
				}>((message) => {
					if (message.role === 'assistant') {
						if (!ownedPal) {
							// A tool-only assistant has no public message body or media.
							if (message.content === null && message.toolCalls?.length) return []
							const phase = storedAssistantPhase(message)
							return [
								{
									messageId: message.id,
									role: message.role,
									content: message.content,
									...(phase ? { phase } : {}),
									...(messageTime(message.id, message.role)
										? { time: messageTime(message.id, message.role) }
										: {}),
								},
							]
						}
						if (message.id && cancelled?.get(message.id) === message.content) return []
						const content = palPublicAssistantText(message)
						return content === undefined
							? []
							: [
									{
										messageId: message.id,
										role: message.role,
										content,
										...(messageTime(message.id, message.role)
											? { time: messageTime(message.id, message.role) }
											: {}),
									},
								]
					}
					return message.role === 'user' &&
						(!message.source ||
							(message.source.type === 'runtime-context' && message.source.kind === 'steering'))
						? [
								{
									messageId: message.id,
									role: message.role,
									content: message.content,
									...(messageTime(message.id, message.role)
										? { time: messageTime(message.id, message.role) }
										: {}),
								},
							]
						: []
				})
				if (!ownedPal) {
					// Display-only: a stopped partial reply has no committed message to fold.
					const stopped = cancelledAssistantReplies(snapshot.records)
					for (const reply of stopped.replies) {
						let at = -1
						for (let index = 0; index < shown.length; index++)
							if (
								(shown[index]?.turnId ?? stopped.turnOf(shown[index]?.messageId)) === reply.turnId
							)
								at = index
						if (at < 0)
							for (let index = 0; index < shown.length; index++) {
								const seq = shown[index]?.seq ?? stopped.seqOf(shown[index]?.messageId)
								if (seq !== undefined && seq < reply.startSeq) at = index
							}
						shown.splice(at + 1, 0, {
							messageId: reply.messageId,
							role: 'assistant',
							content: reply.content,
							...(reply.phase ? { phase: reply.phase } : {}),
							...(reply.time ? { time: reply.time } : {}),
							stopReason: 'cancelled',
							turnId: reply.turnId,
							seq: reply.startSeq,
						})
					}
				}
				const retained: { messageId?: string; role: 'user' | 'assistant' }[] = []
				let remaining = 200_000
				let partial = false
				const rows: {
					messageId?: string
					role: 'user' | 'assistant'
					text: string
					phase?: 'commentary' | 'final_answer'
					time?: { at: number; source: 'journal' }
					stopReason?: 'cancelled'
				}[] = []
				for (const message of shown.slice(-200).reverse()) {
					if (remaining <= 0) break
					const content = typeof message.content === 'string' ? message.content : '[Media message]'
					const value = content.slice(0, Math.min(32_000, remaining))
					partial ||= value.length < content.length
					remaining -= value.length
					retained.unshift({ messageId: message.messageId, role: message.role })
					rows.unshift({
						...(historyId(message.messageId) ? { messageId: message.messageId } : {}),
						role: message.role as 'user' | 'assistant',
						text: value,
						...(message.phase ? { phase: message.phase } : {}),
						...(message.time ? { time: message.time } : {}),
						...(message.stopReason ? { stopReason: message.stopReason } : {}),
					})
				}
				return {
					messages: rows,
					partial: partial || rows.length < shown.length || remaining <= 0,
					...(!ownedPal ? { work: historyWork(snapshot.records, retained) } : {}),
				}
			})
		},
		'namzu/conversations/archive': async (params: Record<string, unknown>) => {
			if (
				!params ||
				typeof params !== 'object' ||
				Array.isArray(params) ||
				Object.keys(params).some((key) => key !== 'sessionId')
			)
				throw new Error('Invalid conversation archive request.')
			const requestedId = session(params)
			const home = resolveNamzuHome()
			const assertTrust = () => {
				if (!isTrustedAtStateRoot(cwd, home))
					throw new Error('Trust this folder before archiving its conversations.')
			}
			assertTrust()
			const state = await openSessions(cwd, { stateRoot: home })
			try {
				assertTrust()
				const id = asSessionId(requestedId)
				const facts = await readConversationFacts(state, id)
				const assertJobsIdle = () => {
					const jobs = runtime.jobs(id)
					if (
						!Array.isArray(jobs) ||
						jobs.some((job) => job.status === 'running' || job.recoveryRequired)
					)
						throw new Error('Stop this conversation’s background work before archiving it.')
				}
				if (!facts) {
					let absent = false
					try {
						await lstat(state.paths.sessionLog({ sessionId: id }))
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
						absent = true
					}
					if (!absent)
						throw new Error('This conversation’s journal has no verified session header.')
					const publishedCwd = publishedSessionCwd?.(id)
					if (publishedCwd !== undefined && canonicalProjectPath(publishedCwd) !== cwd)
						throw new Error('This conversation does not belong to this project.')
					assertJobsIdle()
					assertTrust()
					// Absence is an observation, never an archive or execution admission.
					return { sessionId: id, archived: false as const, missing: true as const }
				}
				await ownedSessionIn({ sessionId: requestedId }, state)
				if (facts.activeTurn)
					throw new Error('Resolve this conversation’s open turn before archiving it.')
				assertJobsIdle()
				assertTrust()
				const archive = async () => {
					assertJobsIdle()
					assertTrust()
					try {
						await archiveConversation(state, id)
					} catch (error) {
						// An idempotent retry still passes the real writer/scope gate.
						if (
							!(error instanceof Error) ||
							error.message !== `Conversation ${id} is already archived.`
						)
							throw error
						const current = await readConversationFacts(state, id)
						if (!current?.archived || current.activeTurn) throw error
					}
					return { sessionId: id, archived: true as const }
				}
				const harness = runtime as Partial<CliHarnessRuntime>
				return !palAtWorkspace(cwd, state.root) &&
					typeof harness.withIdleConversationForArchive === 'function'
					? await harness.withIdleConversationForArchive(id, state, archive)
					: await archive()
			} finally {
				closeSessions(state)
			}
		},
		'namzu/tasks/list': async (params: Record<string, unknown>) => {
			return withReadScope(async (state) => {
				const id = asSessionId(await ownedSessionIn(params, state))
				const store = new DiskTaskStore({
					paths: state.paths,
					session: { sessionId: id },
					tenantId: state.tenantId,
				})
				let records: Awaited<ReturnType<DiskTaskStore['listStrict']>>
				try {
					records = await store.listStrict({ sessionId: id })
				} catch {
					throw new Error('Task list unavailable; its records could not be read completely.')
				}
				const tasks = records
					.filter((task) => task.sessionId === id && task.tenantId === state.tenantId)
					.map((task) => ({
						taskId: task.id,
						subject: task.subject,
						status: task.status,
						blockedBy: [...task.blockedBy],
						...(task.owner === undefined ? {} : { owner: task.owner }),
					}))
				return { tasks }
			})
		},
		'namzu/providers/status': async (params: Record<string, unknown>) => {
			const id = params.sessionId === undefined ? undefined : await ownedReadSession(params)
			const status = await runtime.providerStatus(id)
			const model = id ? undefined : pal()?.model
			if (!model) return status
			return {
				...(status as Record<string, unknown>),
				selected: {
					id: model.provider,
					model: model.model,
				},
			}
		},
		'namzu/providers/models': (params: Record<string, unknown>) => {
			const provider = text(params, 'provider')
			if (params.sessionId === undefined) return runtime.models(provider)
			session(params)
			return ownedReadSession(params).then((id) => runtime.models(provider, id))
		},
		'namzu/providers/settings': async (params: Record<string, unknown>) =>
			runtime.modelSettings(
				text(params, 'provider'),
				text(params, 'model'),
				params.sessionId === undefined ? undefined : await ownedReadSession(params),
			),
		'namzu/plugins/list': async (params: Record<string, unknown>) => {
			const id = params.sessionId === undefined ? undefined : await ownedReadSession(params)
			if (pal())
				return {
					plugins: [],
					live: false,
					canChange: false,
					notice: 'Host plugins are not inherited by Pals.',
				}
			return runtime.plugins(cwd, id)
		},
		'namzu/plugins/set_enabled': async (params: Record<string, unknown>) => {
			if (!isTrusted(cwd)) throw new Error('Trust this folder first.')
			if (typeof params.enabled !== 'boolean') throw new Error('Invalid plugin choice.')
			return runtime.setPluginEnabled(
				await ownedSession(params),
				text(params, 'name'),
				params.enabled,
				cwd,
			)
		},
		'namzu/providers/select': async (params: Record<string, unknown>) => {
			if (!isTrusted(cwd)) throw new Error('Trust this folder first.')
			await runtime.selectProvider(
				await ownedSession(params),
				text(params, 'provider'),
				params.model === undefined ? undefined : text(params, 'model'),
			)
			return { selected: true }
		},
		'namzu/jobs/list': async (params: Record<string, unknown>) =>
			runtime.jobs(await ownedReadSession(params)),
		'namzu/jobs/read': async (params: Record<string, unknown>) =>
			runtime.readJob(await ownedReadSession(params), text(params, 'jobId')),
		'namzu/jobs/stop': async (params: Record<string, unknown>) =>
			runtime.stopJob(await ownedSession(params), text(params, 'jobId')),
	}
}
