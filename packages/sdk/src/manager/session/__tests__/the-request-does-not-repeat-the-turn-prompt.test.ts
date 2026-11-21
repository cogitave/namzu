import { describe, expect, it, vi } from 'vitest'

import { EventTranslator } from '../../../runtime/query/events.js'
import { InMemorySessionLog, type SessionLog } from '../../../store/session-log/index.js'
import type { SessionId } from '../../../types/ids/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { TurnRecorder, requestPromptMatchesTurn } from '../turn-recorder.js'

/**
 * The same system prompt was written twice per turn: in `turn_started`, and in
 * the turn's first `request_envelope`. The envelope joins its system messages
 * with a blank line where the turn prompt joins static and dynamic parts with
 * a rule, so the two texts differ by one separator. The record now points at
 * the turn's prompt instead of repeating it; a request whose prompt a step
 * rewrote keeps its own text. The live event keeps the text for live readers.
 */

const LOG = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn(() => LOG),
}
const SESSION = '1b9fa4ed-2300-43ac-9ee1-c641c9ae66d1' as SessionId
const SCOPE = {
	sessionId: SESSION,
	topicId: '07c17470-7e89-4c5e-9680-2d10d92ac22a',
	projectId: '4dfa889d-312b-4570-a8e3-e1ccd3f2274b',
	tenantId: '2c8e25c0-8fc7-4427-8e9e-f338d6e51c02',
}
const STATIC = 'You are a careful assistant.'
const DYNAMIC = 'Today is a Tuesday.'
const TURN_PROMPT = `${STATIC}\n\n---\n\n${DYNAMIC}`
const REQUEST_PROMPT = `${STATIC}\n\n${DYNAMIC}`

async function turn(sessionLog: SessionLog, systemPrompt: string | undefined) {
	const recorder = new TurnRecorder({
		turnId: generateTurnId(),
		agentId: 'a',
		agentName: 'A',
		turnConfig: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
		providerId: 'mock',
		log: LOG,
		...SCOPE,
		sessionLog,
	} as never)
	await recorder.open({ session: { cwd: '/tmp' } })
	const emitter = new EventTranslator(recorder)
	await emitter.beginTurn(systemPrompt === undefined ? {} : { systemPrompt })
	recorder.markRunning()
	return recorder
}

async function envelopeRecord(
	sessionLog: SessionLog,
	recorder: TurnRecorder,
	systemPrompt: string,
	iteration = 1,
) {
	await recorder.appendEvent({
		type: 'request_envelope',
		sessionId: SESSION,
		turnId: recorder.turnId,
		iteration,
		model: 'mock',
		systemPrompt,
		toolNames: [],
		toolSchemaDigest: 'd',
	} as never)
	const all = await sessionLog.readAll()
	return all.entries
		.map((e) => e.record as unknown as Record<string, unknown>)
		.filter((r) => r.type === 'request_envelope')
		.at(-1)
}

describe('a request does not repeat the turn prompt', () => {
	it('matches the turn prompt up to its one separator', () => {
		expect(requestPromptMatchesTurn(REQUEST_PROMPT, TURN_PROMPT)).toBe(true)
		expect(requestPromptMatchesTurn(STATIC, STATIC)).toBe(true)
		expect(requestPromptMatchesTurn(`${REQUEST_PROMPT}\n\nmore`, TURN_PROMPT)).toBe(false)
	})

	it('records a pointer, not the text, when the request prompt is the turn prompt', async () => {
		const log = new InMemorySessionLog({ sessionId: SESSION })
		const recorder = await turn(log, TURN_PROMPT)
		const record = await envelopeRecord(log, recorder, REQUEST_PROMPT)
		expect(record?.systemPrompt).toBeUndefined()
		expect(record?.systemPromptFrom).toBe('turn_started')
		const all = await log.readAll()
		const started = all.entries
			.map((e) => e.record as unknown as Record<string, unknown>)
			.find((r) => r.type === 'turn_started')
		expect(started?.systemPrompt).toBe(TURN_PROMPT)
	})

	it('keeps the text when a step rewrote the prompt', async () => {
		const log = new InMemorySessionLog({ sessionId: SESSION })
		const recorder = await turn(log, TURN_PROMPT)
		const record = await envelopeRecord(log, recorder, `${REQUEST_PROMPT}\n\na new instruction`, 3)
		expect(record?.systemPrompt).toContain('a new instruction')
		expect(record?.systemPromptFrom).toBeUndefined()
	})

	it('keeps the text when the turn recorded no prompt', async () => {
		const log = new InMemorySessionLog({ sessionId: SESSION })
		const recorder = await turn(log, undefined)
		const record = await envelopeRecord(log, recorder, REQUEST_PROMPT)
		expect(record?.systemPrompt).toBe(REQUEST_PROMPT)
	})
})
