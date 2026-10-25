/**
 * A resumed conversation shows what the live run showed: the same tool rows,
 * the same closing line, the same note when the operator interrupted, and the
 * rows of the agents it launched. The tool rows come from the live path's own
 * builders, so the first group compares against them instead of restating
 * their wording.
 */
import {
	type Message,
	type SessionEvent,
	type SessionRecord,
	type ToolCall,
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { journalOf, rememberJournal } from '../../integrations/sessions/journal-trail.js'
import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import { projectConversation } from '../App.js'
import { doneClock } from '../agent-transcript-rows.js'
import { type AgentEvent, builtinToolPresenter, toAgentEvent } from '../agent.js'
import { numberDetailRows, trailFromRecords, withSavedAgentRows } from '../restored-rows.js'
import { type ToolRow, formatToolCall, toolEndRows } from '../tool-end-rows.js'
import { webCallTitle } from '../web-activity.js'

const TURN = '00000000-0000-4000-8000-000000000001'
const SESSION = '00000000-0000-4000-8000-0000000000aa'

const call = (id: string, name: string, args: unknown): ToolCall => ({
	id,
	type: 'function',
	function: { name, arguments: JSON.stringify(args) },
})

function ids() {
	let id = 0
	return () => `row-${++id}`
}

/** The rows a row list holds, without ids and the numbering the screen adds. */
function plain(rows: readonly { id: string }[]) {
	return rows.map(({ id: _id, ...row }) => {
		const { detailRef: _ref, ...rest } = row as typeof row & { detailRef?: number }
		return rest
	})
}

/** The rows the live run draws for one call, from the events the kernel emits for it. */
function liveRows(events: readonly SessionEvent[]): readonly ToolRow[] {
	const presenter = builtinToolPresenter()
	let start: Extract<AgentEvent, { kind: 'tool-start' }> | undefined
	for (const event of events) {
		const mapped = toAgentEvent(event, presenter)
		if (mapped?.kind === 'tool-start') start = mapped
		if (mapped?.kind !== 'tool-end' || !start) continue
		const built = toolEndRows(
			mapped,
			{
				label: start.web
					? webCallTitle(start.web)
					: formatToolCall(start.toolName, start.summary, start.standalone),
				...(start.detail ? { detail: start.detail } : {}),
				...(start.command ? { command: start.command } : {}),
				...(start.proposed ? { proposed: start.proposed } : {}),
				...(start.web ? { web: start.web } : {}),
				...(start.activity ? { activity: start.activity } : {}),
			},
			{ hasPlan: true },
		)
		return built.kind === 'rows' ? built.rows : []
	}
	return []
}

const executing = (id: string, name: string, input: unknown) =>
	({
		type: 'tool_executing',
		sessionId: SESSION,
		turnId: TURN,
		toolUseId: id,
		toolName: name,
		input,
	}) as unknown as SessionEvent

const completed = (id: string, name: string, result: string, extra: Record<string, unknown> = {}) =>
	({
		type: 'tool_completed',
		sessionId: SESSION,
		turnId: TURN,
		toolUseId: id,
		toolName: name,
		result,
		isError: false,
		...extra,
	}) as unknown as SessionEvent

const asRecord = (event: SessionEvent, seq: number, ts = '2026-10-24T10:00:00.000Z') =>
	({ v: 1, id: `rec-${seq}`, seq, ts, ...event }) as unknown as SessionRecord

function withIds(messages: Message[]): Message[] {
	return messages.map((message, index) => ({ ...message, id: `msg-${index}` }) as Message)
}

function messageRecords(messages: readonly Message[], turnId = TURN): SessionRecord[] {
	return messages.map(
		(message, index) =>
			({
				v: 1,
				id: `m-${index}`,
				seq: 100 + index,
				ts: '2026-10-24T10:00:00.000Z',
				type: 'message',
				sessionId: SESSION,
				turnId,
				messageId: message.id,
				role: message.role,
				content: message,
			}) as unknown as SessionRecord,
	)
}

const FILE_FACTS = { kind: 'read', path: '/p/a.ts', totalLines: 40, returnedLines: 40 } as const

describe('a resumed conversation draws its tool calls like the live run', () => {
	it('restores read, search, edit, write and shell rows from the saved messages alone', () => {
		const messages = [
			createUserMessage('tidy up'),
			createAssistantMessage(null, [
				call('r', 'read', { path: 'a.ts' }),
				call('g', 'grep', { pattern: 'foo' }),
				call('e', 'edit', { path: 'a.ts', old_string: 'x\ny', new_string: 'x\nz\nw' }),
				call('w', 'write', { path: 'n.txt', content: 'hi\nthere\n' }),
				call('b', 'bash', { command: 'echo hi' }),
			]),
			createToolMessage('     1\tconst a = 1\n', 'r'),
			createToolMessage('a.ts:1:foo\n', 'g'),
			createToolMessage('Edited /p/a.ts: 1 replacement(s)', 'e'),
			createToolMessage('Created n.txt (+2 -0) · 9 bytes', 'w'),
			createToolMessage('hi\n', 'b'),
			createAssistantMessage('Done.'),
		]
		const rows = projectConversation(messages, ids())
		expect(rows.map((row) => [row.glyph ?? row.role, row.content])).toEqual([
			['user', 'tidy up'],
			['⎿', 'Read a.ts'],
			['⎿', 'Searched for foo'],
			['●', 'Update(a.ts)'],
			['⎿', 'Edited a.ts'],
			['●', 'Write(n.txt)'],
			['⎿', 'Wrote 2 lines to n.txt'],
			['●', 'Bash(echo hi)'],
			['assistant', 'Done.'],
		])
		// The edit keeps its diff body, the command its cell, the read its output behind Ctrl+O.
		expect(rows.find((row) => row.content === 'Update(a.ts)')?.detail).toEqual([
			'- x',
			'- y',
			'+ x',
			'+ z',
			'+ w',
		])
		expect(rows.find((row) => row.content === 'Bash(echo hi)')?.shell?.stdout).toEqual(['hi'])
		expect(rows.find((row) => row.content === 'Read a.ts')?.detailRef).toBe(1)
	})

	it('draws a journaled call exactly as the live events drew it, typed facts and all', () => {
		const messages = withIds([
			createUserMessage('look'),
			createAssistantMessage(null, [call('r', 'read', { path: 'a.ts' })]),
			createToolMessage('     1\tconst a = 1\n', 'r'),
			createAssistantMessage(null, [
				call('e', 'edit', { path: '/p/a.ts', old_string: 'one', new_string: 'two\nthree' }),
			]),
			createToolMessage('Edited /p/a.ts: 1 replacement(s)', 'e'),
		])
		const events = {
			r: [
				executing('r', 'read', { path: 'a.ts' }),
				completed('r', 'read', '     1\tconst a = 1\n', { facts: FILE_FACTS }),
			],
			e: [
				executing('e', 'edit', { path: '/p/a.ts', old_string: 'one', new_string: 'two\nthree' }),
				completed('e', 'edit', 'Edited /p/a.ts: 1 replacement(s)', {
					facts: { kind: 'edit', path: '/p/a.ts', replacements: 1 },
					durationMs: 12,
				}),
			],
		}
		const records = [
			...events.r.map((event, index) => asRecord(event, index + 1)),
			...events.e.map((event, index) => asRecord(event, index + 10)),
			...messageRecords(messages),
		]
		const rows = projectConversation(messages, ids(), [], { trail: trailFromRecords(records) })
		const tools = rows.filter((row) => row.role === 'tool')
		expect(plain(tools)).toEqual([...liveRows(events.r), ...liveRows(events.e)].map((row) => row))
		// And the typed fact shows: the read names its file, as live.
		expect(tools[0]?.content).toBe('Read a.ts')
		expect(tools.map((row) => row.content)).toContain('Edited a.ts')
	})

	it('draws a journaled edit with its counts and hunks exactly as the live run did', () => {
		const hunks = [
			{
				oldStart: 3,
				oldLines: 2,
				newStart: 3,
				newLines: 3,
				lines: [' keep', '-one', '+two', '+three'],
			},
		]
		const facts = {
			kind: 'edit',
			path: '/p/a.ts',
			replacements: 1,
			added: 2,
			removed: 1,
			hunks,
		} as const
		const messages = withIds([
			createUserMessage('edit it'),
			createAssistantMessage(null, [
				call('e', 'edit', { path: '/p/a.ts', old_string: 'one', new_string: 'two\nthree' }),
			]),
			createToolMessage('Edited /p/a.ts: 1 replacement(s) (+2 -1)', 'e'),
		])
		const events = [
			executing('e', 'edit', { path: '/p/a.ts', old_string: 'one', new_string: 'two\nthree' }),
			completed('e', 'edit', 'Edited /p/a.ts: 1 replacement(s) (+2 -1)', { facts, durationMs: 5 }),
		]
		const records = [
			...events.map((event, index) => asRecord(event, index + 1)),
			...messageRecords(messages),
		]
		const rows = projectConversation(messages, ids(), [], { trail: trailFromRecords(records) })
		const tools = rows.filter((row) => row.role === 'tool')
		expect(plain(tools)).toEqual([...liveRows(events)])
		expect(tools[0]?.content).toBe('Update(/p/a.ts)')
		expect(tools[1]?.content).toBe('Added 2 lines, removed 1 line')
		expect(tools[1]?.diff?.hunks).toEqual(hunks)
		expect(tools[1]?.detail).toEqual([' 3  keep', ' 4 -one', ' 4 +two', ' 5 +three'])
	})

	it('keeps the counts of an edit in a conversation saved without its journal', () => {
		const messages = [
			createUserMessage('edit it'),
			createAssistantMessage(null, [
				call('e', 'edit', { path: 'a.ts', old_string: 'one', new_string: 'two\nthree' }),
			]),
			createToolMessage('Edited /p/a.ts: 1 replacement(s) (+2 -1)', 'e'),
		]
		const rows = projectConversation(messages, ids())
		const tools = rows.filter((row) => row.role === 'tool')
		expect(tools.map((row) => row.content)).toEqual([
			'Update(a.ts)',
			'Added 2 lines, removed 1 line',
		])
	})

	it('shows a failed call and a call that never reported a result', () => {
		const messages = [
			createUserMessage('go'),
			createAssistantMessage(null, [
				call('x', 'nope_tool', { a: 1 }),
				call('i', 'bash', { command: 'sleep 99' }),
			]),
			createToolMessage('boom', 'x', true),
			createToolMessage(
				'Tool execution was interrupted and no durable result is available for `bash`. Its outcome is unknown.',
				'i',
				true,
			),
		]
		const rows = projectConversation(messages, ids())
		expect(rows.map((row) => [row.glyph ?? row.role, row.content])).toEqual([
			['user', 'go'],
			['●', 'Nope tool({"a":1})'],
			['○', 'Bash(sleep 99)'],
			['⎿', 'Interrupted'],
		])
	})

	it('leaves a delegation to the agent rows and keeps a failed launch', () => {
		const messages = [
			createUserMessage('delegate'),
			createAssistantMessage(null, [
				call('ok', 'Agent', { description: 'Count words' }),
				call('bad', 'Agent', { description: 'Fail' }),
			]),
			createToolMessage('the answer', 'ok'),
			createToolMessage('could not start', 'bad', true),
		]
		const rows = projectConversation(messages, ids())
		expect(rows.map((row) => row.content)).toEqual(['delegate', 'Agent(Fail)'])
		// The failed launch's error text hangs under the call, as the tool wrote it.
		expect(rows[1]?.shell?.stderr).toEqual(['Error: could not start'])
	})
})

describe('a resumed conversation closes and interrupts its turns as the live run did', () => {
	function turnRecords(
		messages: readonly Message[],
		end: Record<string, unknown>,
		seconds: number,
	): SessionRecord[] {
		return [
			{
				v: 1,
				id: 'ts',
				seq: 1,
				ts: '2026-10-24T10:00:00.000Z',
				type: 'turn_started',
				sessionId: SESSION,
				turnId: TURN,
			} as unknown as SessionRecord,
			...messageRecords(messages),
			{
				v: 1,
				id: 'te',
				seq: 500,
				ts: new Date(Date.parse('2026-10-24T10:00:00.000Z') + seconds * 1000).toISOString(),
				type: 'turn_completed',
				sessionId: SESSION,
				turnId: TURN,
				result: '',
				...end,
			} as unknown as SessionRecord,
		]
	}

	const base = withIds([createUserMessage('slow one'), createAssistantMessage('Finished.')])

	it('ends a turn that took a while with its Worked-for line', () => {
		const trail = trailFromRecords(turnRecords(base, {}, 46))
		const rows = projectConversation(base, ids(), [], { trail })
		const endedAt = Date.parse('2026-10-24T10:00:00.000Z') + 46 * 1000
		expect(rows.map((row) => row.content)).toEqual([
			'slow one',
			'Finished.',
			`Worked for 46s · done ${doneClock(new Date(endedAt))}`,
		])
		expect(rows.at(-1)?.glyph).toBe('✻')
	})

	it('adds no line to a turn that was over at once', () => {
		const trail = trailFromRecords(turnRecords(base, {}, 1))
		expect(projectConversation(base, ids(), [], { trail }).map((row) => row.content)).toEqual([
			'slow one',
			'Finished.',
		])
	})

	it('says Interrupted for a turn the operator stopped, and names a limit that stopped one', () => {
		const stopped = projectConversation(base, ids(), [], {
			trail: trailFromRecords(
				turnRecords(base, { stopReason: 'cancelled', cancelCause: 'user' }, 30),
			),
		})
		expect(stopped.at(-1)?.content).toBe('Interrupted.')
		const limited = projectConversation(base, ids(), [], {
			trail: trailFromRecords(turnRecords(base, { stopReason: 'max_iterations' }, 30)),
		})
		expect(limited.at(-1)?.content).toBe('The reply stopped at its step limit.')
	})
})

describe('the agents a resumed conversation launched', () => {
	const agent = (
		input: Partial<SubagentActivity> & Pick<SubagentActivity, 'viewId'>,
	): SubagentActivity => ({
		agentId: 'general-purpose',
		description: input.viewId,
		prompt: 'p',
		batchId: 'batch-1',
		workflowId: TURN,
		workflowGroupId: 'group-1',
		phaseId: 'phase-1',
		workflow: 'Delegated work',
		phase: 'Work',
		phaseSequence: 0,
		status: 'completed',
		startedAt: 1_000,
		completedAt: 9_000,
		toolCalls: 3,
		tokens: 1200,
		transcript: [],
		replayed: true,
		...input,
	})

	const messages = withIds([
		createUserMessage('delegate'),
		createAssistantMessage('On it.', [call('a', 'Agent', { description: 'Count words' })]),
		createToolMessage('the answer', 'a'),
		createAssistantMessage('All done.'),
	])
	const records = [
		{
			v: 1,
			id: 'ts',
			seq: 1,
			ts: '2026-10-24T10:00:00.000Z',
			type: 'turn_started',
			sessionId: SESSION,
			turnId: TURN,
		},
		asRecord(executing('a', 'Agent', { description: 'Count words' }), 2),
		...messageRecords(messages),
	] as unknown as SessionRecord[]

	it('places the launch and the result after the reply that launched them, once the children are read', () => {
		const rows = projectConversation(messages, ids(), [], { trail: trailFromRecords(records) })
		expect(rows.map((row) => row.content)).toEqual(['delegate', 'On it.', 'All done.'])
		const placed = withSavedAgentRows(rows, [agent({ viewId: 'Count words' })], ids())
		expect(placed.map((row) => row.content)).toEqual([
			'delegate',
			'On it.',
			'Launched Count words',
			'general-purpose (Count words)',
			'Done (3 tool uses · 1.2k tokens · 8s)',
			'All done.',
		])
		// Placed once: the marker is gone, so a second read changes nothing.
		expect(placed.some((row) => row.agentTurnId !== undefined)).toBe(false)
		expect(withSavedAgentRows(placed, [agent({ viewId: 'Count words' })], ids())).toBe(placed)
	})

	it('waits for the children when none are known yet', () => {
		const rows = projectConversation(messages, ids(), [], { trail: trailFromRecords(records) })
		expect(withSavedAgentRows(rows, [], ids())).toBe(rows)
	})

	it('numbers the bodies Ctrl+O opens in order', () => {
		const numbered = numberDetailRows([
			{ id: '1', role: 'tool', content: 'a', activity: 'exploration', detail: ['x'] },
			{ id: '2', role: 'tool', content: 'b' },
			{ id: '3', role: 'tool', content: 'c', activity: 'exploration', detail: ['y'] },
		])
		expect(numbered.map((row) => row.detailRef)).toEqual([1, undefined, 2])
	})
})

describe('the journal behind a loaded conversation', () => {
	it('is found from the message list the loader returned, and from no other', () => {
		const loaded = [createUserMessage('hi')]
		const records = [] as SessionRecord[]
		rememberJournal(loaded, records)
		expect(journalOf(loaded)).toBe(records)
		expect(journalOf([...loaded])).toBeUndefined()
	})
})
