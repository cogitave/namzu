import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import {
	DiskSessionLog,
	InMemorySessionLog,
	readStructuredOutput,
} from '../../../store/session-log/index.js'
import type { AnswerReview } from '../../../types/session/answer-review.js'
import type { SessionEvent } from '../../../types/session/events.js'
import { SESSION_RECORD_MAX_BYTES } from '../../../types/session/records.js'
import { generateTurnId } from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'
import { readToolExecutions } from '../tool-executions.js'
import { memorySession, records, terminalRecords } from './support/session.js'

const directories: string[] = []
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true })
})

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((accept) => {
		resolve = accept
	})
	return { promise, resolve }
}

function fixture(
	selected: { score: number; text?: string },
	options: { spilling?: boolean; spillAboveBytes?: number } = { spilling: true },
) {
	const session = memorySession()
	const sessionLog = new InMemorySessionLog({
		sessionId: session.sessionId,
		structuredResultSpilling: options.spilling,
		spillAboveBytes: options.spillAboveBytes,
	})
	const transform = vi.fn((value: { score: number }) => ({ score: value.score + 1 }))
	const schema = z.object({ score: z.number() }).transform(transform)
	const selectedJson = JSON.stringify(selected)
	const provider = new MockLLMProvider({
		turns: [{ toolCalls: [{ id: 'candidate', name: 'structured_output', args: { score: 1 } }] }],
	})
	const pluginManager = {
		executeHooks: vi.fn(async (phase: string, context: { toolName?: string }) =>
			phase === 'post_tool_use' && context.toolName === 'structured_output'
				? [{ action: 'replace' as const, output: selectedJson }]
				: [],
		),
	} as unknown as PluginLifecycleManager
	const review = vi.fn((): AnswerReview | Promise<AnswerReview> => ({ accept: true }))
	const params = {
		...session,
		sessionLog,
		provider,
		pluginManager,
		toolsets: [],
		agentId: 'spilled-structured-output',
		agentName: 'Spilled structured output',
		messages: [{ role: 'user' as const, content: 'Return a structured answer.' }],
		workingDirectory: process.cwd(),
		turnId: generateTurnId(),
		turnConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 10_000, maxIterations: 3 },
		structuredOutput: { schema, toolResultRetention: 'durable', maxRetries: 0, review },
		maxToolOutputChars: 100,
		resumeHandler: async () => ({ action: 'continue' as const }),
	} satisfies QueryParams
	return { params, provider, review, transform, sessionLog, selectedJson }
}

describe('opt-in structured result spilling through the query', () => {
	it('accepts over 4 MiB from a screened post-hook receipt and reads both results in a new disk-log instance', async () => {
		const selected = { score: 8, text: 'x'.repeat(SESSION_RECORD_MAX_BYTES + 4_096) }
		const f = fixture(selected)
		const directory = await mkdtemp(join(tmpdir(), 'namzu-structured-spill-query-'))
		directories.push(directory)
		const diskOptions = {
			sessionId: f.params.sessionId,
			file: join(directory, `${f.params.sessionId}.jsonl`),
			sessionDir: join(directory, f.params.sessionId),
			structuredResultSpilling: true,
		}
		const log = new DiskSessionLog(diskOptions)
		const events: SessionEvent[] = []
		const turn = await drainQuery({ ...f.params, sessionLog: log }, (event) => {
			events.push(event)
		})

		expect(turn.status).toBe('completed')
		expect(turn.structuredOutput).toEqual(selected)
		expect(turn.result).toBe(f.selectedJson)
		expect(f.review).toHaveBeenCalledOnce()
		expect(f.review).toHaveBeenCalledWith(selected, expect.anything())
		expect(f.transform).toHaveBeenCalledOnce()
		expect(f.provider.requests).toHaveLength(1)
		expect(f.transform.mock.calls[0]?.[0]).toEqual({ score: 1 })
		const toolMessage = turn.messages.find((message) => message.role === 'tool')
		expect(typeof toolMessage?.content).toBe('string')
		expect((toolMessage?.content as string).length).toBeLessThanOrEqual(100)
		expect(toolMessage).not.toHaveProperty('structuredResultJson')
		expect(turn.steps?.[0]?.toolResults?.[0]).not.toHaveProperty('structuredResultSpill')
		expect(events.find((event) => event.type === 'tool_completed')).toMatchObject({
			result: toolMessage?.content,
			structuredResultJson: f.selectedJson,
		})

		// A separate log instance reads only durable files, with no in-process
		// candidate cache. Both completion evidence and accepted output must survive.
		const reopened = new DiskSessionLog(diskOptions)
		const read = await reopened.readAll({ mode: 'strict' })
		expect(read.intact).toBe(true)
		for (const entry of read.entries) {
			expect(entry.pointer.length).toBeLessThanOrEqual(SESSION_RECORD_MAX_BYTES)
			expect(entry.record.v).toBe(1)
		}
		const completion = read.entries.find((entry) => entry.record.type === 'tool_completed')?.record
		expect(completion).toHaveProperty('structuredResultSpill')
		expect(completion).not.toHaveProperty('structuredResultJson')
		const snapshot = await readToolExecutions(reopened, f.params.turnId, ['candidate'])
		expect(snapshot.complete).toBe(true)
		expect(snapshot.records.get('candidate')).toMatchObject({
			result: toolMessage?.content,
			structuredResultJson: f.selectedJson,
		})
		const completed = (await terminalRecords(reopened))[0]
		if (completed?.type !== 'turn_completed') throw new Error('Missing successful settlement.')
		expect(completed).toHaveProperty('structuredOutputSpill')
		expect(completed.settlement).not.toHaveProperty('structuredOutput')
		expect(await readStructuredOutput(reopened, completed)).toEqual(selected)
		expect(completed.resultSpill).toBeDefined()
		if (!completed.resultSpill) throw new Error('Missing result text spill.')
		expect(await reopened.readSpill(completed.resultSpill)).toBe(f.selectedJson)
	})

	it('spills accepted native output expanded asynchronously from small model text without tool retention', async () => {
		const session = memorySession()
		const log = new InMemorySessionLog({
			sessionId: session.sessionId,
			structuredResultSpilling: true,
		})
		const selected = { score: 2, text: 'n'.repeat(SESSION_RECORD_MAX_BYTES + 4_096) }
		const transform = vi.fn(async ({ score }: { score: number }) => ({
			score,
			text: selected.text,
		}))
		const schema = z.object({ score: z.number() }).transform(transform)
		const provider = new MockLLMProvider({
			turns: [{ text: '{"score":2}' }],
			capabilities: {
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: true,
				supportsNativeStructuredOutput: true,
			},
		})
		const review = vi.fn(() => ({ accept: true as const }))
		const events: SessionEvent[] = []
		const turn = await drainQuery(
			{
				...session,
				sessionLog: log,
				provider,
				toolsets: [],
				agentId: 'native-spilled-structured-output',
				agentName: 'Native spilled structured output',
				messages: [{ role: 'user', content: 'Return a structured answer.' }],
				workingDirectory: process.cwd(),
				turnId: generateTurnId(),
				turnConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 10_000, maxIterations: 3 },
				structuredOutput: { mode: 'native', schema, maxRetries: 0, review },
				maxToolCalls: 0,
				maxToolOutputChars: 100,
			},
			(event) => {
				events.push(event)
			},
		)
		expect(turn.status).toBe('completed')
		expect(turn.stopReason).toBe('end_turn')
		expect(turn.structuredOutput).toEqual(selected)
		expect(turn.result).toBe(JSON.stringify(selected))
		expect(transform).toHaveBeenCalledOnce()
		expect(transform.mock.calls[0]?.[0]).toEqual({ score: 2 })
		expect(review).toHaveBeenCalledOnce()
		expect(review).toHaveBeenCalledWith(selected, expect.anything())
		expect(provider.requests).toHaveLength(1)
		expect(provider.requests[0]?.responseFormat).toMatchObject({
			type: 'json_schema',
			json_schema: { name: 'structured_output', strict: true },
		})
		expect(
			events.filter((event) => event.type === 'tool_executing' || event.type === 'tool_completed'),
		).toEqual([])
		const reopened = log.reopen()
		const read = await reopened.readAll({ mode: 'strict' })
		expect(read.entries.some((entry) => entry.record.type === 'tool_completed')).toBe(false)
		for (const entry of read.entries)
			expect(entry.pointer.length).toBeLessThanOrEqual(SESSION_RECORD_MAX_BYTES)
		const completed = (await terminalRecords(reopened))[0]
		if (completed?.type !== 'turn_completed') throw new Error('Missing native settlement.')
		expect(completed.settlement.resultSource).toBe('structured_output')
		expect(completed).toHaveProperty('structuredOutputSpill')
		expect(completed.settlement).not.toHaveProperty('structuredOutput')
		expect(await readStructuredOutput(reopened, completed)).toEqual(selected)
	})

	it.each(['completion append', 'review'] as const)(
		'does not accept a candidate cancelled during %s',
		async (phase) => {
			const f = fixture(
				{ score: 8, text: 'x'.repeat(8_000) },
				{
					spilling: true,
					spillAboveBytes: 1_024,
				},
			)
			const controller = new AbortController()
			const entered = deferred()
			const release = deferred()
			const write = f.sessionLog.spillStore.write.bind(f.sessionLog.spillStore)
			if (phase === 'completion append') {
				vi.spyOn(f.sessionLog.spillStore, 'write').mockImplementation(
					async (key, content, text) => {
						if (text === f.selectedJson) {
							entered.resolve()
							await release.promise
						}
						return write(key, content, text)
					},
				)
			} else {
				f.review.mockImplementation(() => {
					entered.resolve()
					return release.promise.then(() => ({ accept: true as const }))
				})
			}
			const pending = drainQuery({ ...f.params, signal: controller.signal })
			await entered.promise
			controller.abort(new Error(`Cancelled during ${phase}`))
			release.resolve()
			const turn = await pending
			expect(turn.status).toBe('cancelled')
			expect(turn.structuredOutput).toBeUndefined()
			if (phase === 'completion append') expect(f.review).not.toHaveBeenCalled()
			else expect(f.review).toHaveBeenCalledOnce()
			const completion = (await records(f.sessionLog)).find(
				(record) => record.type === 'tool_completed',
			)
			expect(completion).toHaveProperty('structuredResultSpill')
			const completed = (await terminalRecords(f.sessionLog))[0]
			if (completed?.type !== 'turn_completed') throw new Error('Missing cancelled settlement.')
			expect(completed.settlement.status).toBe('cancelled')
			expect(completed).not.toHaveProperty('structuredOutputSpill')
			expect(completed.settlement).not.toHaveProperty('structuredOutput')
			expect(await readStructuredOutput(f.sessionLog, completed)).toBeUndefined()
		},
	)

	it.each(['completion', 'settlement'] as const)(
		'does not report successful acceptance when the %s spill write fails',
		async (phase) => {
			const f = fixture(
				{ score: 8, text: 'x'.repeat(8_000) },
				{
					spilling: true,
					spillAboveBytes: 1_024,
				},
			)
			let terminalAppend = false
			const append = f.sessionLog.append.bind(f.sessionLog)
			vi.spyOn(f.sessionLog, 'append').mockImplementation(async (lease, draft) => {
				terminalAppend = draft.type === 'turn_completed'
				try {
					return await append(lease, draft)
				} finally {
					terminalAppend = false
				}
			})
			const write = f.sessionLog.spillStore.write.bind(f.sessionLog.spillStore)
			vi.spyOn(f.sessionLog.spillStore, 'write').mockImplementation(async (key, content, text) => {
				if (text === f.selectedJson && terminalAppend === (phase === 'settlement')) {
					throw new Error('Structured spill storage unavailable')
				}
				return write(key, content, text)
			})
			await expect(drainQuery(f.params)).rejects.toThrow('Structured spill storage unavailable')
			expect(f.review).toHaveBeenCalledTimes(phase === 'settlement' ? 1 : 0)
			const terminal = await terminalRecords(f.sessionLog)
			expect(terminal.filter((record) => record.type === 'turn_completed')).toEqual([])
			const completions = (await records(f.sessionLog)).filter(
				(record) => record.type === 'tool_completed',
			)
			expect(completions).toHaveLength(phase === 'settlement' ? 1 : 0)
		},
	)

	it('keeps the existing oversized-record failure when the spilling option is absent', async () => {
		const f = fixture({ score: 8, text: 'x'.repeat(SESSION_RECORD_MAX_BYTES + 4_096) }, {})
		await expect(drainQuery(f.params)).rejects.toThrow(/record.*limit/i)
		expect(f.review).not.toHaveBeenCalled()
		expect(f.provider.requests).toHaveLength(1)
		expect(
			(await terminalRecords(f.sessionLog)).filter((record) => record.type === 'turn_completed'),
		).toEqual([])
	})

	it.each([undefined, false, true])(
		'keeps small durable results inline (spilling: %s)',
		async (spilling) => {
			const selected = { score: 8 }
			const f = fixture(selected, { spilling })
			const turn = await drainQuery(f.params)
			expect(turn.status).toBe('completed')
			expect(turn.structuredOutput).toEqual(selected)
			const logged = await records(f.sessionLog)
			const completion = logged.find((record) => record.type === 'tool_completed')
			expect(completion).toHaveProperty('structuredResultJson', f.selectedJson)
			expect(completion).not.toHaveProperty('structuredResultSpill')
			const completed = (await terminalRecords(f.sessionLog))[0]
			if (completed?.type !== 'turn_completed') throw new Error('Missing inline settlement.')
			expect(completed).not.toHaveProperty('structuredOutputSpill')
			expect(completed.settlement.structuredOutput).toEqual(selected)
			expect(await readStructuredOutput(f.sessionLog, completed)).toEqual(selected)
			expect(f.transform).toHaveBeenCalledOnce()
		},
	)
})
