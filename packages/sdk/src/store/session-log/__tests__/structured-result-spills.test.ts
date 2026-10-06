import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { TurnRecorder } from '../../../manager/session/turn-recorder.js'
import { ToolExecutor } from '../../../runtime/query/executor.js'
import { recoverCompletedCalls } from '../../../runtime/query/resume-pending.js'
import {
	ToolExecutionCollector,
	readToolExecutions,
} from '../../../runtime/query/tool-executions.js'
import { testToolset } from '../../../test-support/toolset.js'
import { createStructuredOutputTool } from '../../../tools/builtins/structuredOutput.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import { type SessionRecord, SessionRecordSchema } from '../../../types/session/records.js'
import type { TurnSettlement } from '../../../types/session/turn.js'
import {
	generateMessageId,
	generateProjectId,
	generateSessionId,
	generateTurnId,
} from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import { ActivityStore } from '../../activity/memory.js'
import {
	InMemoryLogMedium,
	InMemorySessionLog,
	InMemorySpillStore,
	InvalidSessionRecordError,
	STRUCTURED_RESULT_MAX_BYTES,
	SpillIntegrityError,
	type SpillRef,
	readStructuredOutput,
} from '../index.js'
import type { InMemorySessionLogOptions } from '../memory.js'
import { sha256Hex } from '../spill.js'

type Completion = Extract<SessionRecord, { type: 'turn_completed' }>

afterEach(() => vi.restoreAllMocks())

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function settlement(extra: Partial<TurnSettlement> = {}): TurnSettlement {
	return {
		status: 'completed',
		iterations: 1,
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
		durationMs: 0,
		resultSource: 'structured_output',
		abandonedTaskIds: [],
		abandonedJobIds: [],
		...extra,
	}
}

async function session(options: Partial<InMemorySessionLogOptions> = {}) {
	const log = new InMemorySessionLog({
		sessionId: generateSessionId(),
		spillAboveBytes: 1024,
		structuredResultSpilling: true,
		...options,
	})
	const lease = await log.claim({ holder: 'structured-spill-test', ttlMs: 60_000 })
	if (!lease) throw new Error('The test could not claim its session.')
	await log.append(lease, {
		type: 'session_started',
		projectId: generateProjectId(),
		cwd: '/tmp',
		agent: { id: 'test', name: 'Test' },
	})
	const turnId = generateTurnId()
	const started = await log.beginTurn(lease, {
		turnId,
		userMessageId: generateMessageId(),
		config: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
	})
	return { log, lease, turnId, started }
}

type TestSession = Awaited<ReturnType<typeof session>>

function candidate(f: TestSession, json: string, id = 'output_call') {
	return f.log.append(f.lease, {
		type: 'tool_completed',
		turnId: f.turnId,
		toolUseId: id,
		toolName: 'structured_output',
		result: '[bounded structured receipt]',
		isError: false,
		structuredResultJson: json,
	})
}

async function terminal(
	f: TestSession,
	value: unknown,
	extra: Partial<TurnSettlement> = {},
	result = '[bounded final receipt]',
): Promise<Completion> {
	const entry = await f.log.append(f.lease, {
		type: 'turn_completed',
		turnId: f.turnId,
		result,
		settlement: settlement({ structuredOutput: value, ...extra }),
	})
	if (entry.record.type !== 'turn_completed') throw new Error('Expected a terminal record.')
	return entry.record
}

function refOf(record: SessionRecord): SpillRef {
	const ref =
		record.type === 'tool_completed'
			? record.structuredResultSpill
			: record.type === 'turn_completed'
				? record.structuredOutputSpill
				: undefined
	if (!ref) throw new Error('Expected a structured result spill.')
	return ref
}

function refFor(json: string): SpillRef {
	const path = `tool-results/${sha256Hex('custom-reader')}.txt`
	return {
		path,
		manifest: `${path}.manifest.json`,
		bytes: Buffer.byteLength(json, 'utf8'),
		sha256: sha256Hex(json),
	}
}

const large = { text: 'Pal 🦉 '.repeat(700) }
const largeJson = JSON.stringify(large)

describe('opt-in durable structured result spilling', () => {
	it('writes every selected body before its record and gives retries, terminal JSON and preview separate keys', async () => {
		const spills = new InMemorySpillStore()
		const medium = new InMemoryLogMedium()
		const f = await session({ spills, medium })
		const write = vi.spyOn(spills, 'write')
		const append = medium.append.bind(medium)
		const atAppend: { ref: SpillRef; json: string }[] = []
		vi.spyOn(medium, 'append').mockImplementation(async (bytes, offset) => {
			const record = JSON.parse(Buffer.from(bytes).toString('utf8')) as SessionRecord
			const ref = refOf(record)
			atAppend.push({ ref, json: await f.log.readSpill(ref) })
			await append(bytes, offset)
		})
		const first = await candidate(f, largeJson)
		const different = { text: 'second candidate '.repeat(500) }
		const second = await candidate(f, JSON.stringify(different))
		const preview = 'final text '.repeat(800)
		const done = await terminal(f, different, {}, preview)
		const r1 = refOf(first.record)
		const r2 = refOf(second.record)
		const r3 = refOf(done)

		expect(first.record).not.toHaveProperty('structuredResultJson')
		expect(done.settlement).not.toHaveProperty('structuredOutput')
		expect(new Set([r1.path, r2.path, r3.path, done.resultSpill?.path]).size).toBe(4)
		expect(atAppend).toEqual([
			{ ref: r1, json: largeJson },
			{ ref: r2, json: JSON.stringify(different) },
			{ ref: r3, json: JSON.stringify(different) },
		])
		expect(write.mock.calls.map(([key, content]) => [key, content])).toEqual([
			[`record:${first.record.id}:structuredResult`, 'text'],
			[`record:${second.record.id}:structuredResult`, 'text'],
			[`record:${done.id}:structuredOutput`, 'text'],
			[`record:${done.id}`, 'message'],
		])
		expect(await f.log.readSpill(r1)).toBe(largeJson)
		expect(await f.log.readSpill(done.resultSpill as SpillRef)).toBe(preview)
		const verified = (await f.log.readAll({ mode: 'strict' })).entries.at(-1)?.record
		expect(verified).toEqual(done)
		expect(await readStructuredOutput(f.log, done)).toEqual(different)
	})

	it('preserves default inline records and keeps opt-in spilling when an in-memory log reopens', async () => {
		const legacy = await session({ structuredResultSpilling: undefined })
		const inline = await candidate(legacy, largeJson)
		expect(inline.record).toHaveProperty('structuredResultJson', largeJson)
		expect(inline.record).not.toHaveProperty('structuredResultSpill')
		const f = await session()
		const reopened = { ...f, log: f.log.reopen() }
		const entry = await candidate(reopened, largeJson)
		expect(await reopened.log.readSpill(refOf(entry.record))).toBe(largeJson)
	})

	it('does not append a completion when its spill write fails', async () => {
		const f = await session()
		const head = await f.log.head()
		const append = vi.spyOn(f.log.medium, 'append')
		const failed = new Error('durable storage refused the body')
		vi.spyOn(f.log.spillStore, 'write').mockRejectedValue(failed)
		await expect(candidate(f, largeJson)).rejects.toBe(failed)
		expect(append).not.toHaveBeenCalled()
		expect(await f.log.head()).toEqual(head)
	})

	it.each(['tool', 'terminal'] as const)(
		'refuses a %s body above the fixed 16 MiB cap before any spill or record write',
		async (kind) => {
			expect(STRUCTURED_RESULT_MAX_BYTES).toBe(16 * 1024 * 1024)
			const f = await session()
			const append = vi.spyOn(f.log.medium, 'append')
			const write = vi.spyOn(f.log.spillStore, 'write')
			const value = 'x'.repeat(STRUCTURED_RESULT_MAX_BYTES)
			const head = await f.log.head()
			await expect(
				kind === 'tool' ? candidate(f, JSON.stringify(value)) : terminal(f, value),
			).rejects.toBeInstanceOf(InvalidSessionRecordError)
			expect(write).not.toHaveBeenCalled()
			expect(append).not.toHaveBeenCalled()
			expect(await f.log.head()).toEqual(head)
		},
	)

	it.each(['{"text":"'.concat('x'.repeat(2000)), '1e400', '-0'])(
		'cannot hide invalid inline candidate JSON by spilling it (%s)',
		async (json) => {
			const f = await session()
			const write = vi.spyOn(f.log.spillStore, 'write')
			const append = vi.spyOn(f.log.medium, 'append')
			await expect(candidate(f, json)).rejects.toBeInstanceOf(InvalidSessionRecordError)
			expect(write).not.toHaveBeenCalled()
			expect(append).not.toHaveBeenCalled()
		},
	)

	it.each([
		{ status: 'cancelled' as const },
		{ resultSource: 'model' as const },
		{ resultSource: 'review' as const },
		{ resultSource: 'guardrail_rewritten' as const },
	])(
		'refuses a small contradictory settlement before spilling or appending (%j)',
		async (extra) => {
			const f = await session()
			const write = vi.spyOn(f.log.spillStore, 'write')
			const append = vi.spyOn(f.log.medium, 'append')
			await expect(terminal(f, 1, extra)).rejects.toBeInstanceOf(InvalidSessionRecordError)
			expect(write).not.toHaveBeenCalled()
			expect(append).not.toHaveBeenCalled()
		},
	)
})

describe('strict structured result references', () => {
	it('rejects contradictory completion classifications and unsafe or oversized references', async () => {
		const f = await session()
		const record = (await candidate(f, largeJson)).record
		const ref = refOf(record)
		const badRefs = [
			{ ...ref, path: '../outside.txt' },
			{ ...ref, manifest: `tool-results/${'0'.repeat(64)}.txt.manifest.json` },
			{ ...ref, bytes: STRUCTURED_RESULT_MAX_BYTES + 1 },
			{ ...ref, bytes: 0 },
			{ ...ref, bytes: 1.5 },
			{ ...ref, sha256: 'wrong' },
		]
		const invalid = [
			{ ...record, structuredResultJson: 'null' },
			{ ...record, isError: true },
			{ ...record, skipped: true },
			{ ...record, inputFailure: 'schema_validation', isError: true },
			{ ...record, via: { tool: 'parent', toolUseId: 'parent_call' } },
			{ ...record, toolName: 'other_tool' },
			...badRefs.map((structuredResultSpill) => ({ ...record, structuredResultSpill })),
		]
		for (const broken of invalid) {
			expect(SessionRecordSchema.safeParse(broken).success).toBe(false)
			const collector = new ToolExecutionCollector(f.turnId, ['output_call'])
			expect(() => collector.accept(broken as SessionRecord)).toThrow()
			expect(collector.finish().records.size).toBe(0)
		}
		expect(SessionRecordSchema.safeParse(record).success).toBe(true)
	})

	it('rejects terminal refs beside inline output, cancelled status or a non-structured result source', async () => {
		const f = await session()
		const done = await terminal(f, large)
		const read = vi.spyOn(f.log, 'readSpill')
		for (const extra of [
			{ structuredOutput: null },
			{ status: 'cancelled' },
			...['model', 'review', 'guardrail_blocked', 'guardrail_rewritten', 'outstanding_work'].map(
				(resultSource) => ({ resultSource }),
			),
		]) {
			const broken = { ...done, settlement: { ...done.settlement, ...extra } }
			expect(SessionRecordSchema.safeParse(broken).success).toBe(false)
			await expect(readStructuredOutput(f.log, broken as Completion)).rejects.toThrow()
		}
		expect(read).not.toHaveBeenCalled()
	})
})

describe('explicit checked structured output reads', () => {
	it('decodes spilled null without borrowing the final text preview as structured output', async () => {
		const f = await session()
		const done = await terminal(f, null, {}, 'preview '.repeat(700))
		expect(await f.log.readSpill(refOf(done))).toBe('null')
		expect(done.settlement).not.toHaveProperty('structuredOutput')
		expect(done.resultSpill).toBeDefined()
		expect(await readStructuredOutput(f.log, done)).toBeNull()
	})

	it.each([null, false, 12, 'text', [1, null], { nested: { value: 'safe' } }])(
		'preserves an inline JSON value and detaches returned data (%j)',
		async (value) => {
			const f = await session()
			const done = await terminal(f, value)
			const read = vi.spyOn(f.log, 'readSpill')
			const restored = await readStructuredOutput(f.log, done)
			expect(restored).toEqual(value)
			if (typeof value === 'object' && value !== null) {
				expect(restored).not.toBe(done.settlement.structuredOutput)
			}
			expect(read).not.toHaveBeenCalled()
		},
	)

	it('returns undefined for no accepted output and refuses foreign sessions or contradictory legacy inline fields', async () => {
		const f = await session()
		const done = await terminal(f, undefined)
		expect(await readStructuredOutput(f.log, done)).toBeUndefined()
		expect(
			await readStructuredOutput(f.log, {
				...done,
				settlement: { ...done.settlement, status: 'cancelled' },
			}),
		).toBeUndefined()
		for (const broken of [
			{ ...done, sessionId: generateSessionId() },
			{ ...done, type: 'turn_failed' },
			{
				...done,
				settlement: { ...done.settlement, status: 'cancelled', structuredOutput: 1 },
			},
			{
				...done,
				settlement: { ...done.settlement, resultSource: 'model', structuredOutput: 1 },
			},
			{ ...done, settlement: { ...done.settlement, structuredOutput: Number.NaN } },
		]) {
			await expect(readStructuredOutput(f.log, broken as Completion)).rejects.toThrow()
		}
	})

	it('passes the fixed byte bound to a custom reader and independently checks UTF-8 bytes, hash and JSON', async () => {
		const f = await session()
		const done = await terminal(f, large)
		const read = vi.spyOn(f.log, 'readSpill')
		const controller = new AbortController()
		read.mockResolvedValue(largeJson)
		expect(await readStructuredOutput(f.log, done, { signal: controller.signal })).toEqual(large)
		expect(read).toHaveBeenCalledExactlyOnceWith(refOf(done), {
			maxBytes: STRUCTURED_RESULT_MAX_BYTES,
			signal: controller.signal,
		})
		for (const badBody of ['{}', largeJson.replace('Pal', 'Bad'), null as unknown as string]) {
			read.mockResolvedValue(badBody)
			await expect(readStructuredOutput(f.log, done)).rejects.toBeInstanceOf(SpillIntegrityError)
		}
		for (const badJson of ['not JSON', '1e400', '-0']) {
			read.mockResolvedValue(badJson)
			await expect(
				readStructuredOutput(f.log, { ...done, structuredOutputSpill: refFor(badJson) }),
			).rejects.toThrow()
		}
	})

	it('does no I/O for an already cancelled read and stops waiting for an uncooperative custom reader', async () => {
		const f = await session()
		const done = await terminal(f, large)
		const controller = new AbortController()
		const reason = new Error('operator cancelled structured hydration')
		const read = vi.spyOn(f.log, 'readSpill')
		controller.abort(reason)
		await expect(readStructuredOutput(f.log, done, { signal: controller.signal })).rejects.toBe(
			reason,
		)
		expect(read).not.toHaveBeenCalled()

		const pendingController = new AbortController()
		const entered = deferred<void>()
		const body = deferred<string>()
		read.mockImplementation(async () => {
			entered.resolve()
			return body.promise
		})
		const hydration = readStructuredOutput(f.log, done, { signal: pendingController.signal })
		const refusal = expect(hydration).rejects.toBe(reason)
		await entered.promise
		pendingController.abort(reason)
		await refusal
		body.resolve(largeJson)
		await body.promise
		expect(read).toHaveBeenCalledOnce()
		await expect(hydration).rejects.toBe(reason)
	})
})

describe('selected structured completion hydration during recovery', () => {
	it('preflights the 64 MiB aggregate of selected references before reading any body or authorizing replay', async () => {
		const f = await session()
		const calls = []
		for (let index = 0; index < 5; index++) {
			const id = `large_output_${index}`
			const path = `tool-results/${sha256Hex(id)}.txt`
			await f.log.append(f.lease, {
				type: 'tool_completed',
				turnId: f.turnId,
				toolUseId: id,
				toolName: 'structured_output',
				result: '[bounded structured receipt]',
				isError: false,
				structuredResultSpill: {
					path,
					manifest: `${path}.manifest.json`,
					bytes: STRUCTURED_RESULT_MAX_BYTES,
					sha256: sha256Hex('unread body'),
				},
			})
			calls.push({
				id,
				type: 'function' as const,
				function: { name: 'structured_output', arguments: '{}' },
			})
		}
		const read = vi.spyOn(f.log, 'readSpill')
		await expect(
			readToolExecutions(
				f.log,
				f.turnId,
				calls.map(({ id }) => id),
			),
		).rejects.toThrow(`${64 * 1024 * 1024}-byte aggregate limit`)
		const logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			child: vi.fn(),
		} as unknown as Logger
		const recovered = await recoverCompletedCalls(
			{ log: f.log, turnId: f.turnId, flush: async () => {} } as unknown as TurnRecorder,
			calls,
			logger,
		)
		expect(recovered.size).toBe(5)
		for (const outcome of recovered.values()) {
			expect(outcome.isError).toBe(true)
			expect(outcome.result).toContain('outcome is unknown')
			expect(outcome).not.toHaveProperty('structuredResultJson')
		}
		expect(read).not.toHaveBeenCalled()
	})

	it.each(['start', 'inline'] as const)(
		'a later %s removes an earlier missing spill from the selected state',
		async (later) => {
			const f = await session()
			await candidate(f, largeJson)
			if (later === 'start') {
				await f.log.append(f.lease, {
					type: 'tool_executing',
					turnId: f.turnId,
					toolUseId: 'output_call',
					toolName: 'structured_output',
					input: {},
				})
			} else {
				await candidate(f, 'null')
			}
			const read = vi.spyOn(f.log, 'readSpill').mockRejectedValue(new Error('old body missing'))
			const snapshot = await readToolExecutions(f.log, f.turnId, ['output_call'])
			expect(snapshot.complete).toBe(true)
			expect(snapshot.records.get('output_call')).toMatchObject(
				later === 'start'
					? { status: 'started' }
					: { status: 'completed', structuredResultJson: 'null' },
			)
			expect(read).not.toHaveBeenCalled()
		},
	)

	it('hydrates only the latest selected spill after the entire log has verified', async () => {
		const f = await session()
		const old = refOf((await candidate(f, largeJson)).record)
		const other = refOf((await candidate(f, largeJson, 'unselected_call')).record)
		const newer = JSON.stringify({ text: 'new result '.repeat(700) })
		const latest = refOf((await candidate(f, newer)).record)
		const original = f.log.readSpill.bind(f.log)
		const read = vi.spyOn(f.log, 'readSpill').mockImplementation(async (ref, options) => {
			if (ref.path === old.path || ref.path === other.path) throw new Error('old body missing')
			return original(ref, options)
		})
		const snapshot = await readToolExecutions(f.log, f.turnId, ['output_call'])
		expect(snapshot.complete).toBe(true)
		expect(snapshot.records.size).toBe(1)
		expect(snapshot.records.get('output_call')).toHaveProperty('structuredResultJson', newer)
		expect(read).toHaveBeenCalledExactlyOnceWith(latest, {
			maxBytes: STRUCTURED_RESULT_MAX_BYTES,
			signal: undefined,
		})

		// An invalid later record must refuse the scan before any body is read.
		read.mockClear()
		f.log.medium.overwrite(Buffer.concat([f.log.medium.bytes(), Buffer.from('not JSON\n')]))
		await expect(readToolExecutions(f.log, f.turnId, ['output_call'])).rejects.toThrow()
		expect(read).not.toHaveBeenCalled()
	})

	it('keeps a synchronous collector incomplete until the selected body is checked', async () => {
		const f = await session()
		await candidate(f, largeJson)
		const collector = new ToolExecutionCollector(f.turnId, ['output_call'])
		for (const entry of (await f.log.readAll({ mode: 'strict' })).entries) {
			collector.accept(entry.record)
		}
		const synchronous = collector.finish()
		expect(synchronous.complete).toBe(false)
		expect(synchronous.records.get('output_call')).not.toHaveProperty('structuredResultJson')
		const hydrated = await collector.finishWithSpills(f.log)
		expect(hydrated.complete).toBe(true)
		expect(hydrated.records.get('output_call')).toHaveProperty('structuredResultJson', largeJson)
		expect(synchronous.records.get('output_call')).not.toHaveProperty('structuredResultJson')
	})

	it.each(['missing', 'corrupt'] as const)(
		'refuses a current %s spill and recovers unknown without rerunning the schema or tool',
		async (failure) => {
			const f = await session()
			await candidate(f, largeJson)
			const read = vi.spyOn(f.log, 'readSpill')
			if (failure === 'missing') read.mockRejectedValue(new SpillIntegrityError('body', 'missing'))
			else read.mockResolvedValue(largeJson.replace('Pal', 'Bad'))
			await expect(readToolExecutions(f.log, f.turnId, ['output_call'])).rejects.toThrow()
			const logger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				child: vi.fn(),
			} as unknown as Logger
			const response: ChatCompletionResponse = {
				id: 'mock-recovered-response',
				model: 'mock',
				message: {
					role: 'assistant',
					content: null,
					toolCalls: [
						{
							id: 'output_call',
							type: 'function',
							function: { name: 'structured_output', arguments: largeJson },
						},
					],
				},
				finishReason: 'tool_calls',
				usage: settlement().usage,
			}
			const recovered = await recoverCompletedCalls(
				{ log: f.log, turnId: f.turnId, flush: async () => {} } as unknown as TurnRecorder,
				response.message.toolCalls ?? [],
				logger,
			)
			expect(recovered.get('output_call')).toMatchObject({ isError: true })
			expect(recovered.get('output_call')?.result).toContain('outcome is unknown')
			expect(recovered.get('output_call')).not.toHaveProperty('structuredResultJson')
			const refine = vi.fn(() => {})
			const owner = createStructuredOutputTool(z.object({ text: z.string() }).superRefine(refine))
			const tools = new ToolManager({ toolsets: [testToolset(owner)], messages: () => [] })
			const execute = vi.spyOn(tools, 'executePrepared')
			const emit = vi.fn(async () => {})
			const executor = new ToolExecutor(
				{
					tools,
					durableStructuredOutputTool: owner,
					turnId: f.turnId,
					sessionId: f.log.sessionId,
					workingDirectory: '/tmp',
					permissionMode: 'auto',
					env: {},
					abortSignal: new AbortController().signal,
					toolResultGuardrails: [],
				},
				new ActivityStore(f.turnId, {
					enabled: false,
					trackToolCalls: false,
					trackLlmTurns: false,
				}),
				emit,
				logger,
			)
			const batch = await executor.executeBatch(response, undefined, recovered)
			expect(batch.results[0]).toMatchObject({ isError: true })
			expect(batch.results[0]).not.toHaveProperty('structuredResultJson')
			expect(refine).not.toHaveBeenCalled()
			expect(execute).not.toHaveBeenCalled()
			expect(emit).not.toHaveBeenCalled()
		},
	)
})
