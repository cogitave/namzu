/**
 * A declined edit that comes back with a resumed conversation draws the change
 * it would have made with the same line numbers the live row had: they are
 * found by locating the old text in the working folder's file, so the folder
 * has to reach the restored row.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	type Message,
	type SessionEvent,
	type SessionRecord,
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { projectConversation } from '../App.js'
import { builtinToolPresenter, toAgentEvent } from '../agent.js'
import { trailFromRecords } from '../restored-rows.js'
import { toolEndRows } from '../tool-end-rows.js'
import type { TranscriptMessage } from '../types.js'

const TURN = '00000000-0000-4000-8000-000000000001'
const SESSION = '00000000-0000-4000-8000-0000000000aa'
const input = {
	path: 'src/a.ts',
	old_string: 'const c = 3',
	new_string: 'const c = 33',
}

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-declined-'))
	dirs.push(dir)
	mkdirSync(join(dir, 'src'))
	writeFileSync(join(dir, 'src/a.ts'), 'const a = 1\nconst b = 2\nconst c = 3\nconst d = 4\n')
	return dir
}

const event = (type: string, extra: Record<string, unknown>) =>
	({
		type,
		sessionId: SESSION,
		turnId: TURN,
		toolUseId: 'e',
		toolName: 'edit',
		...extra,
	}) as unknown as SessionEvent
const record = (e: SessionEvent, seq: number) =>
	({
		v: 1,
		id: `rec-${seq}`,
		seq,
		ts: '2026-10-24T10:00:00.000Z',
		...e,
	}) as unknown as SessionRecord

function rowsOf(cwd: string | undefined): readonly TranscriptMessage[] {
	const messages: Message[] = [
		createUserMessage('change c'),
		createAssistantMessage(null, [
			{
				id: 'e',
				type: 'function',
				function: { name: 'edit', arguments: JSON.stringify(input) },
			},
		]),
		createToolMessage('The user declined this tool call.', 'e', true),
	].map((m, i) => ({ ...m, id: `msg-${i}` }) as Message)
	const records = [
		record(event('tool_executing', { input }), 1),
		record(
			event('tool_completed', {
				result: 'The user declined this tool call.',
				isError: true,
				presentation: { kind: 'generic', label: 'src/a.ts', declined: {} },
			}),
			2,
		),
		...messages.map(
			(message, index) =>
				({
					v: 1,
					id: `m-${index}`,
					seq: 100 + index,
					ts: '2026-10-24T10:00:00.000Z',
					type: 'message',
					sessionId: SESSION,
					turnId: TURN,
					messageId: message.id,
					role: message.role,
					content: message,
				}) as unknown as SessionRecord,
		),
	]
	let n = 0
	return projectConversation(messages, () => `row-${++n}`, [], {
		trail: trailFromRecords(records),
		...(cwd ? { cwd } : {}),
	})
}

describe('a restored declined edit', () => {
	it('numbers its lines from where the old text sits, like the live row', () => {
		const cwd = project()
		const restored = rowsOf(cwd).find((row) => row.diff)
		// The live row for the same call and folder.
		const presenter = builtinToolPresenter()
		const started = toAgentEvent(
			record(event('tool_executing', { input }), 1) as never,
			presenter,
			undefined,
			cwd,
		)
		const ended = toAgentEvent(
			record(
				event('tool_completed', {
					result: 'The user declined this tool call.',
					isError: true,
					presentation: { kind: 'generic', label: 'src/a.ts', declined: {} },
				}),
				2,
			) as never,
			presenter,
			undefined,
			cwd,
		)
		if (started?.kind !== 'tool-start' || ended?.kind !== 'tool-end') throw new Error('events')
		const live = toolEndRows(
			ended,
			{
				label: 'x',
				...(started.proposed ? { proposed: started.proposed } : {}),
			},
			{ hasPlan: true, cwd },
		)
		if (live.kind !== 'rows') throw new Error('rows')
		const liveDetail = live.rows.find((row) => row.diff)?.detail
		expect(liveDetail?.[0]).toMatch(/^\s*3 /u)
		expect(restored?.detail).toEqual(liveDetail)
	})

	it('numbers from 1 when the working folder is unknown', () => {
		const restored = rowsOf(undefined).find((row) => row.diff)
		expect(restored?.detail?.[0]).toMatch(/^\s*1 /u)
	})
})
