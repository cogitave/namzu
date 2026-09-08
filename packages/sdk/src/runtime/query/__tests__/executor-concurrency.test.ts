import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ToolContext, ToolRegistryContract } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor } from '../executor.js'

const mockRunId = '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as RunId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return {
		...stub,
		child: vi.fn(() => ({ ...stub, child: vi.fn() })),
	} as unknown as Logger
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Two tool calls in one assistant message (one batch). */
function twoCallResponse(name: string, a: object, b: object, prefix = 'c'): ChatCompletionResponse {
	return {
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: `${prefix}1`,
					type: 'function',
					function: { name, arguments: JSON.stringify(a) },
				},
				{
					id: `${prefix}2`,
					type: 'function',
					function: { name, arguments: JSON.stringify(b) },
				},
			],
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

describe('ToolExecutor — concurrencySafe batching', () => {
	let activityStore: ActivityStore
	let emitEvent: (e: RunEvent) => Promise<void>

	beforeEach(() => {
		activityStore = new ActivityStore(mockRunId, {
			enabled: true,
			trackToolCalls: true,
			trackLlmTurns: true,
		})
		emitEvent = async () => {}
	})

	it('serializes concurrency-unsafe tools so read-modify-write does not race', async () => {
		// Shared mutable state, mutated via read → await → write (like `edit`).
		let file = 'A'
		const execute = vi.fn(async (_name: string, input: unknown) => {
			const current = file // read
			await delay(10) // window a parallel run would exploit
			file = current + (input as { add: string }).add // write
			return { success: true, output: 'ok' }
		})
		const tools = {
			register: vi.fn(),
			unregister: vi.fn(),
			execute,
			// edit/write/bash declare concurrencySafe:false → isConcurrencySafe()=>false
			get: vi.fn(() => ({ isConcurrencySafe: () => false })),
			has: vi.fn(() => true),
			listNames: vi.fn(() => []),
			getAvailability: vi.fn(),
		} as unknown as ToolRegistryContract

		const exec = new ToolExecutor(
			{
				tools,
				runId: mockRunId,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
			},
			activityStore,
			emitEvent,
			makeLogger(),
		)
		await exec.executeBatch(twoCallResponse('edit', { add: 'B' }, { add: 'C' }))
		// Serialized: A→AB→ABC. A racing run would lose one append (e.g. 'AC').
		expect(file).toBe('ABC')
	})

	it('runs concurrency-safe tools in parallel', async () => {
		let active = 0
		let maxActive = 0
		const execute = vi.fn(async () => {
			active++
			maxActive = Math.max(maxActive, active)
			await delay(10)
			active--
			return { success: true, output: 'ok' }
		})
		const tools = {
			register: vi.fn(),
			unregister: vi.fn(),
			execute,
			get: vi.fn(() => ({ isConcurrencySafe: () => true })),
			has: vi.fn(() => true),
			listNames: vi.fn(() => []),
			getAvailability: vi.fn(),
		} as unknown as ToolRegistryContract

		const exec = new ToolExecutor(
			{
				tools,
				runId: mockRunId,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
			},
			activityStore,
			emitEvent,
			makeLogger(),
		)
		await exec.executeBatch(twoCallResponse('grep', { p: '1' }, { p: '2' }))
		expect(maxActive).toBe(2) // both ran at once
	})

	it('gives one durable batch identity to sibling calls and a new identity to the next wave', async () => {
		const seen: { call?: string; batch?: string }[] = []
		const tools = {
			register: vi.fn(),
			unregister: vi.fn(),
			execute: vi.fn(async (_name: string, _input: unknown, context: ToolContext) => {
				seen.push({ call: context.toolUseId, batch: context.toolBatchId })
				return { success: true, output: 'ok' }
			}),
			get: vi.fn(() => ({ isConcurrencySafe: () => true })),
			has: vi.fn(() => true),
			listNames: vi.fn(() => []),
			getAvailability: vi.fn(),
		} as unknown as ToolRegistryContract
		const exec = new ToolExecutor(
			{
				tools,
				runId: mockRunId,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
			},
			activityStore,
			emitEvent,
			makeLogger(),
		)

		await exec.executeBatch(twoCallResponse('read', {}, {}, 'wave-a-'))
		await exec.executeBatch(twoCallResponse('read', {}, {}, 'wave-b-'))

		expect(new Set(seen.slice(0, 2).map((entry) => entry.batch))).toEqual(
			new Set([JSON.stringify([String(mockRunId), 'wave-a-1'])]),
		)
		expect(new Set(seen.slice(2).map((entry) => entry.batch))).toEqual(
			new Set([JSON.stringify([String(mockRunId), 'wave-b-1'])]),
		)
		expect(seen.map((entry) => entry.call).sort()).toEqual([
			'wave-a-1',
			'wave-a-2',
			'wave-b-1',
			'wave-b-2',
		])

		const reusedProviderCallId = new ToolExecutor(
			{
				tools,
				runId: 'aa8782b2-efc4-4132-a29a-7cc3eb639864' as RunId,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
			},
			activityStore,
			emitEvent,
			makeLogger(),
		)
		await reusedProviderCallId.executeBatch(twoCallResponse('read', {}, {}, 'wave-a-'))

		expect(new Set(seen.slice(4).map((entry) => entry.batch))).toEqual(
			new Set([JSON.stringify(['aa8782b2-efc4-4132-a29a-7cc3eb639864', 'wave-a-1'])]),
		)
		expect(seen[4]?.batch).not.toBe(seen[0]?.batch)
	})

	function probe(
		run: (name: string, context: ToolContext) => Promise<{ success: boolean; output: string }>,
		options: {
			barrier?: boolean
			signal?: AbortSignal
			timeoutMs?: number
		} = {},
	) {
		const tools = {
			get: (name: string) => ({
				name,
				isConcurrencySafe: () => name !== 'write',
				executionBarrier: name === 'write' && (options.barrier ?? true),
			}),
			execute: (name: string, _input: unknown, context: ToolContext) => run(name, context),
			has: () => true,
			listNames: () => [],
			getAvailability: () => 'active',
		} as unknown as ToolRegistryContract
		const executor = new ToolExecutor(
			{
				tools,
				runId: mockRunId,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: options.signal ?? new AbortController().signal,
				...(options.timeoutMs === undefined ? {} : { toolTimeoutMs: options.timeoutMs }),
			},
			activityStore,
			emitEvent,
			makeLogger(),
		)
		return (...names: string[]) => {
			const response = twoCallResponse('unused', {}, {})
			response.message.toolCalls = names.map((name, i) => ({
				id: `c${i}`,
				type: 'function',
				function: { name, arguments: '{}' },
			}))
			return executor.executeBatch(response)
		}
	}

	function latch() {
		let resolve!: () => void
		const promise = new Promise<void>((done) => {
			resolve = done
		})
		return { promise, resolve }
	}

	it('a barrier waits for earlier reads and lets independent reads overlap in both segments', async () => {
		const earlier = latch()
		const later = latch()
		const writing = latch()
		const finishWrite = latch()
		const events: string[] = []
		let value = 'before'
		const execute = probe(async (name) => {
			events.push(`${name}:${value}`)
			if (name.startsWith('before')) await earlier.promise
			else if (name === 'write') {
				writing.resolve()
				await finishWrite.promise
				value = 'after'
			} else await later.promise
			return { success: true, output: value }
		})
		const pending = execute('before1', 'before2', 'write', 'after1', 'after2')
		await vi.waitFor(() => expect(events).toEqual(['before1:before', 'before2:before']))
		earlier.resolve()
		await writing.promise
		expect(events).toEqual(['before1:before', 'before2:before', 'write:before'])
		finishWrite.resolve()
		await vi.waitFor(() => expect(events.slice(3)).toEqual(['after1:after', 'after2:after']))
		later.resolve()
		const batch = await pending
		expect(batch.results.map((result) => result.toolName)).toEqual([
			'before1',
			'before2',
			'write',
			'after1',
			'after2',
		])
	})

	it('preserves the legacy unsafe-write / safe-read overlap without opt-in', async () => {
		const read = latch()
		let observed = ''
		let value = 'before'
		const execute = probe(
			async (name) => {
				if (name === 'write') {
					await read.promise
					value = 'after'
				} else {
					observed = value
					read.resolve()
				}
				return { success: true, output: value }
			},
			{ barrier: false },
		)
		await execute('write', 'read')
		expect(observed).toBe('before')
		expect(value).toBe('after')
	})

	it('cancellation before a queued barrier prevents it and later calls from executing', async () => {
		const controller = new AbortController()
		const started = latch()
		const calls: string[] = []
		const execute = probe(
			async (name, context) => {
				calls.push(name)
				started.resolve()
				await new Promise<void>((resolve) =>
					context.abortSignal.addEventListener('abort', () => resolve(), {
						once: true,
					}),
				)
				return { success: true, output: 'stopped' }
			},
			{ signal: controller.signal },
		)
		const pending = execute('read', 'write', 'later')
		await started.promise
		controller.abort(new Error('stop before mutation'))
		const batch = await pending
		expect(calls).toEqual(['read'])
		expect(batch.results.slice(1).every((result) => result.isError)).toBe(true)
	})

	it('a failed barrier settles and permits the following verification', async () => {
		const calls: string[] = []
		const execute = probe(async (name) => {
			calls.push(name)
			return {
				success: name !== 'write',
				output: name === 'write' ? 'failed' : 'unchanged',
			}
		})
		const batch = await execute('write', 'read')
		expect(calls).toEqual(['write', 'read'])
		expect(batch.results.map((result) => result.isError)).toEqual([true, false])
	})

	it('a barrier deadline releases verification with a failed outcome', async () => {
		const calls: string[] = []
		const execute = probe(
			async (name, context) => {
				calls.push(name)
				if (name === 'write')
					await new Promise<void>((resolve) =>
						context.abortSignal.addEventListener('abort', () => resolve(), {
							once: true,
						}),
					)
				return { success: true, output: 'ok' }
			},
			{ timeoutMs: 20 },
		)
		const batch = await execute('write', 'read')
		expect(calls).toEqual(['write', 'read'])
		expect(batch.results[0]?.isError).toBe(true)
		expect(batch.results[1]?.isError).toBe(false)
	})

	it('retains builder metadata in registry copies and orders nested execution without deadlock', async () => {
		let value = 'before'
		const events: string[] = []
		const original = new ToolRegistry()
		for (const name of ['write', 'nested', 'read']) {
			original.register(
				defineTool({
					name,
					description: name,
					inputSchema: z.object({}),
					category: 'analysis',
					permissions: [],
					readOnly: false,
					destructive: false,
					concurrencySafe: true,
					...(name === 'read' ? {} : { executionBarrier: true }),
					execute: async (_input, context) => {
						if (name === 'write') {
							events.push('parent started')
							await context.dispatchTool?.('nested', {})
							events.push('parent finished')
						} else if (name === 'nested') {
							value = 'after'
							events.push('nested finished')
						} else events.push(`read:${value}`)
						return { success: true, output: value }
					},
				}),
			)
		}
		const tools = new ToolRegistry()
		for (const tool of original.getAll()) tools.register({ ...tool })
		expect(tools.get('write')?.executionBarrier).toBe(true)
		expect(tools.get('read')?.executionBarrier).toBeUndefined()
		const executor = new ToolExecutor(
			{
				tools,
				runId: mockRunId,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
			},
			activityStore,
			emitEvent,
			makeLogger(),
		)
		const response = twoCallResponse('write', {}, {})
		if (response.message.toolCalls?.[1]) response.message.toolCalls[1].function.name = 'read'
		const batch = await executor.executeBatch(response)
		expect(batch.results.every((result) => !result.isError)).toBe(true)
		expect(events).toEqual(['parent started', 'nested finished', 'parent finished', 'read:after'])
	})
})
