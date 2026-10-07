import { expect, it } from 'vitest'
import { toolTranscriptPresentation } from '../renderer/tool-transcript-presentation.js'
import { type HistoryWorkSnapshot, restoreHistoryWork } from './history-work.js'
import { applyEvent, emptyThread, restoreMessages } from './projection.js'
import type { ChatMessage } from './protocol.js'

const messages: ChatMessage[] = [
	{ role: 'user', text: 'Review this.' },
	{ role: 'assistant', text: 'Checking.', phase: 'commentary' },
	{ role: 'user', text: 'Also this.' },
	{ role: 'assistant', text: 'Ready.', phase: 'final_answer' },
	{ role: 'user', text: 'Next request.' },
	{ role: 'assistant', text: 'Failed.' },
]
function snapshot(): HistoryWorkSnapshot {
	return {
		v: 1,
		partial: false,
		messages: [
			{ index: 0, messageId: 'u1', turnId: 't1', order: 2 },
			{ index: 1, messageId: 'a1', turnId: 't1', order: 3 },
			{ index: 2, messageId: 'steer1', turnId: 't1', order: 6 },
			{ index: 3, messageId: 'a2', turnId: 't1', order: 8 },
			{ index: 4, messageId: 'u2', turnId: 't2', order: 11 },
			{ index: 5, messageId: 'a3', turnId: 't2', order: 13 },
		],
		turns: [
			{
				turnId: 't1',
				userMessageId: 'u1',
				order: 1,
				status: 'completed',
				reason: 'end_turn',
				durationMs: 4321,
			},
			{
				turnId: 't2',
				userMessageId: 'u2',
				order: 10,
				status: 'failed',
				reason: 'SECRET_ERROR',
				durationMs: 500,
			},
		],
		tools: [
			{
				turnId: 't1',
				toolUseId: 'same',
				name: 'write',
				order: 4,
				status: 'completed',
				presentation: { kind: 'diff', path: 'note.txt', before: 'Old', after: 'New' },
			},
			{
				turnId: 't2',
				toolUseId: 'same',
				name: 'bash',
				order: 12,
				status: 'failed',
				presentation: { kind: 'terminal', command: 'false', output: 'Exit 1' },
			},
		],
	}
}

it('restores ordered receipts and actual steering ownership without fabricating host clocks', () => {
	const work = snapshot()
	work.tools.reverse()
	const restored = restoreHistoryWork(emptyThread(), messages, work)
	expect(restored.messages).toEqual(messages)
	expect(restored.timeline).toEqual([
		{ kind: 'message', index: 0, turn: 1 },
		{ kind: 'message', index: 1, turn: 1 },
		{ kind: 'tool', id: '1:same', turn: 1 },
		{ kind: 'message', index: 2, turn: 1 },
		{ kind: 'message', index: 3, turn: 1 },
		{ kind: 'message', index: 4, turn: 2 },
		{ kind: 'tool', id: '2:same', turn: 2 },
		{ kind: 'message', index: 5, turn: 2 },
	])
	expect(restored.turns).toEqual({
		1: { turnId: 't1', recordedDurationMs: 4321, reason: 'end_turn', stopReason: 'end_turn' },
		2: { turnId: 't2', recordedDurationMs: 500, reason: 'error', stopReason: 'error' },
	})
	expect(restored.tools['1:same']?.view.kind).toBe('diff')
	expect(restored.tools['2:same']?.view.kind).toBe('terminal')
	expect(restored.running).toBe(false)
	expect(restored.permissions).toEqual([])
	expect(restored.retry).toBeUndefined()
	expect(restored.reasoning).toEqual({})
})

it('restores only journal-proven hosted search activity and its recorded boundaries', () => {
	const work = snapshot()
	work.tools = [
		{
			turnId: 't1',
			toolUseId: 'provider-hosted-web-search:0:search',
			name: 'Web search',
			order: 4,
			status: 'completed',
			hosted: true,
			startedAt: 1_700_000_000_000,
			endedAt: 1_700_000_002_000,
			presentation: {
				kind: 'generic',
				label: 'Web search: H100 hourly price · 9 sources',
				presentation: 'activity',
			},
		},
	]
	work.turns[0]!.startedAt = 1_700_000_000_000
	work.turns[0]!.endedAt = 1_700_000_005_000
	const restored = restoreHistoryWork(emptyThread(), messages, work)
	const hosted = restored.tools['1:provider-hosted-web-search:0:search']
	expect(hosted?.view).toEqual(work.tools[0]?.presentation)
	expect(hosted?.startedTime).toEqual({ at: 1_700_000_000_000, source: 'journal' })
	expect(hosted?.endedTime).toEqual({ at: 1_700_000_002_000, source: 'journal' })
	expect(restored.turns[1]).toMatchObject({
		startedTime: { at: 1_700_000_000_000, source: 'journal' },
		endedTime: { at: 1_700_000_005_000, source: 'journal' },
	})
	expect(
		toolTranscriptPresentation(restored, '1:provider-hosted-web-search:0:search'),
	).toMatchObject({
		label: 'Searched the web',
		state: 'completed',
		detailView: { kind: 'generic', label: 'Web search: H100 hourly price · 9 sources' },
	})
	work.tools[0] = {
		...work.tools[0]!,
		status: 'interrupted',
		presentation: undefined,
		endedAt: undefined,
	}
	const interrupted = restoreHistoryWork(emptyThread(), messages, work)
	expect(
		toolTranscriptPresentation(interrupted, '1:provider-hosted-web-search:0:search'),
	).toMatchObject({ label: 'Web search interrupted', state: 'interrupted' })
	expect(JSON.stringify(interrupted.tools)).not.toContain('9 sources')
})

it('preserves a live projection and preserves the text-only legacy fallback', () => {
	const thread = {
		...emptyThread(),
		running: true,
		messages: [{ role: 'assistant' as const, text: 'Current' }],
	}
	expect(restoreHistoryWork(thread, messages, snapshot())).toBe(thread)
	expect(restoreHistoryWork(emptyThread(), messages)).toEqual(
		restoreMessages(emptyThread(), messages),
	)
})

it('rejects ambiguous anchors instead of attaching saved work to a different visible message', () => {
	const fallback = restoreMessages(emptyThread(), messages)
	for (const corrupt of [
		(work: HistoryWorkSnapshot) => {
			work.messages[0]!.messageId = 'a1'
		},
		(work: HistoryWorkSnapshot) => {
			work.messages[2]!.order = 1
		},
		(work: HistoryWorkSnapshot) => {
			work.messages[3]!.turnId = 't2'
		},
		(work: HistoryWorkSnapshot) => {
			work.turns[0]!.userMessageId = 'a1'
		},
	]) {
		const work = snapshot()
		corrupt(work)
		expect(restoreHistoryWork(emptyThread(), messages, work)).toEqual(fallback)
	}
})

it('renders missing, interrupted, skipped and cancelled records truthfully without restoring authority', () => {
	const work = snapshot()
	work.partial = true
	work.turns[1]!.status = 'paused'
	work.tools = ['interrupted', 'skipped', 'cancelled'].map((status, index) => ({
		turnId: 't1',
		toolUseId: `tool${index}`,
		name: 'technical_dispatch',
		order: 4 + index,
		status: status as 'interrupted' | 'skipped' | 'cancelled',
		presentation: {
			kind: 'terminal',
			command: 'SHOULD_NOT_CLAIM_EXECUTION',
			output: 'Old success',
		},
	}))
	const thread = restoreHistoryWork(emptyThread(), messages, work)
	expect(thread.partial).toBeUndefined()
	expect(thread.historyWorkPartial).toBe(true)
	expect(thread.turns[2]?.reason).toBe('paused')
	for (const [index, status] of ['interrupted', 'skipped', 'cancelled'].entries()) {
		const view = toolTranscriptPresentation(thread, `1:tool${index}`)
		expect(view?.state).toBe(status)
		expect(view?.label).toBe(status === 'skipped' ? 'Skipped action' : 'Saved action')
		expect(view?.detailView).toMatchObject({
			kind: 'generic',
			label: expect.stringContaining('Details were not recorded.'),
		})
	}
	expect(JSON.stringify(thread.tools)).not.toContain('SHOULD_NOT_CLAIM_EXECUTION')
})

it('copies the closed public view and bounds it without truncating a diff or exposing extension fields', () => {
	const work = snapshot()
	work.tools[0]!.presentation = {
		kind: 'diff',
		before: 'x'.repeat(32768),
		after: 'y',
		privateInput: 'SECRET',
	} as never
	work.tools[1]!.presentation = {
		kind: 'terminal',
		command: 'false',
		output: 'Exit 1',
		privateInput: 'SECRET',
	} as never
	const thread = restoreHistoryWork(emptyThread(), messages, work)
	expect(thread.tools['1:same']?.view).toMatchObject({
		kind: 'generic',
		label: 'Saved action\nDetails were not recorded.',
	})
	expect(thread.tools['2:same']?.view).toEqual({
		kind: 'terminal',
		command: 'false',
		output: 'Exit 1',
	})
	expect(JSON.stringify(thread)).not.toContain('SECRET')
})

it('refuses excessive snapshot arrays and ignores malformed tool entries safely', () => {
	const work = snapshot()
	work.tools = Array.from({ length: 101 }, () => work.tools[0]!)
	expect(restoreHistoryWork(emptyThread(), messages, work).tools).toEqual({})
	work.tools = [
		null,
		{ ...snapshot().tools[0], name: 'Bad\nname' },
		{ ...snapshot().tools[0], order: { valueOf: null, toString: null } },
	] as never
	expect(Object.keys(restoreHistoryWork(emptyThread(), messages, work).tools)).toHaveLength(0)
})

it('does not regroup a proved turn across an unanchored visible user message', () => {
	const visible: ChatMessage[] = [
		{ role: 'user', text: 'Prompt A' },
		{ role: 'user', text: 'Legacy prompt' },
		{ role: 'assistant', text: 'Answer A' },
	]
	const work: HistoryWorkSnapshot = {
		v: 1,
		partial: false,
		messages: [
			{ index: 0, messageId: 'u', turnId: 't', order: 2 },
			{ index: 2, messageId: 'a', turnId: 't', order: 4 },
		],
		turns: [{ turnId: 't', userMessageId: 'u', order: 1, status: 'completed' }],
		tools: [{ turnId: 't', toolUseId: 'c', name: 'read', order: 3, status: 'completed' }],
	}
	expect(restoreHistoryWork(emptyThread(), visible, work)).toEqual(
		restoreMessages(emptyThread(), visible),
	)
})

it('uses a neutral receipt when a hidden result has no saved public call caption', () => {
	const work = snapshot()
	work.tools[0]!.presentation = { kind: 'generic', label: '', visibility: 'hidden' }
	const thread = restoreHistoryWork(emptyThread(), messages, work)
	expect(toolTranscriptPresentation(thread, '1:same')).toMatchObject({
		label: 'Saved action',
		state: 'completed',
	})
	expect(thread.tools['1:same']?.view).toEqual(work.tools[0]?.presentation)
	expect(toolTranscriptPresentation(thread, '1:same')?.detailView).toBeUndefined()
})

it('lets a genuine resumed call replace its saved receipt rather than duplicating it', () => {
	const work = snapshot()
	work.turns[1]!.status = 'paused'
	work.tools[1]!.status = 'interrupted'
	let thread = restoreHistoryWork(emptyThread(), messages, work)
	thread = applyEvent(thread, { kind: 'retry', sessionId: 's', turnId: 't2' })
	thread = applyEvent(thread, {
		kind: 'state',
		sessionId: 's',
		running: true,
		queued: [],
	})
	thread = applyEvent(thread, {
		kind: 'update',
		projectId: 'p',
		sessionId: 's',
		update: {
			kind: 'tool_call',
			toolCallId: 'same',
			title: 'bash',
			status: 'pending',
			view: { kind: 'terminal', command: 'actual resumed command', output: '' },
		},
	})
	expect(thread.timeline.filter((entry) => entry.kind === 'tool' && entry.turn === 2)).toHaveLength(
		1,
	)
	expect(toolTranscriptPresentation(thread, '2:same')).toMatchObject({
		state: 'running',
		label: 'Running actual resumed command',
	})
	expect(thread.tools['2:same']?.historicalStatus).toBeUndefined()
})

it('restores a stopped partial reply as the same completed, cancelled message the live view keeps', () => {
	const rows: ChatMessage[] = [
		{ role: 'user', text: 'Write it.', messageId: 'u1' },
		{
			role: 'assistant',
			text: 'Partial words',
			messageId: 'm1',
			phase: 'final_answer',
			time: { at: 5, source: 'journal' },
			stopReason: 'cancelled',
		},
		{ role: 'user', text: 'Again.', messageId: 'u2' },
		{ role: 'assistant', text: 'Done.', messageId: 'a2' },
	]
	const work: HistoryWorkSnapshot = {
		v: 1,
		partial: false,
		messages: [
			{ index: 0, messageId: 'u1', turnId: 't1', order: 2 },
			{ index: 2, messageId: 'u2', turnId: 't2', order: 11 },
			{ index: 3, messageId: 'a2', turnId: 't2', order: 13 },
		],
		turns: [
			{ turnId: 't1', userMessageId: 'u1', order: 1, status: 'cancelled', reason: 'cancelled' },
			{ turnId: 't2', userMessageId: 'u2', order: 10, status: 'completed', reason: 'end_turn' },
		],
		tools: [],
	}
	for (const snapshot of [undefined, work]) {
		const thread = restoreHistoryWork(emptyThread(), rows, snapshot)
		expect(thread.messages[1]).toEqual({
			role: 'assistant',
			text: 'Partial words',
			messageId: 'm1',
			phase: 'final_answer',
			time: { at: 5, source: 'journal' },
			status: 'completed',
			stopReason: 'cancelled',
		})
		expect(thread.messages[0]).not.toHaveProperty('stopReason')
		expect(thread.messages[3]).not.toHaveProperty('status')
	}
	const restored = restoreHistoryWork(emptyThread(), rows, work)
	expect(restored.timeline.filter((entry) => entry.kind === 'message').map((e) => e.turn)).toEqual([
		1, 1, 2, 2,
	])
	// A user row can never claim to be a stopped reply.
	expect(
		restoreHistoryWork(emptyThread(), [{ role: 'user', text: 'x', stopReason: 'cancelled' }])
			.messages[0],
	).toEqual({ role: 'user', text: 'x' })
})
