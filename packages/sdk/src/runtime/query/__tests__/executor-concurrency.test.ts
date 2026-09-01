import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityStore } from '../../../store/activity/memory.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ToolContext, ToolRegistryContract } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor } from '../executor.js'

const mockRunId = 'run_test' as RunId

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
				runId: 'run_other' as RunId,
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
			new Set([JSON.stringify(['run_other', 'wave-a-1'])]),
		)
		expect(seen[4]?.batch).not.toBe(seen[0]?.batch)
	})
})
