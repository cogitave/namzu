import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createProbeRegistry } from '../../../probe/registry.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ToolRegistryContract } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor } from '../executor.js'

/**
 * The probe-veto branch was the only result-producing branch in the
 * executor that left `isError` off, and `isError` being optional meant the
 * compiler could not notice. Five lines above it, the `tool_completed`
 * event for the same veto carried `isError: true` — so the run's event
 * stream and the result it returned disagreed about the same call, in the
 * same function.
 *
 * Four things degraded off that one omission, which is why a one-word fix
 * is worth a file of tests: two drivers emit their failure marker only when
 * this is true, so the model read a SUCCESSFUL result whose body begins
 * "Error: …" and its trained failure-recovery path never fired; the
 * persisted step recorded a literal `isError: false`; and compaction's
 * guard against clearing error results silently excluded vetoed ones.
 */

const RUN_ID = 'run_veto' as RunId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function makeToolRegistry(): ToolRegistryContract {
	return {
		register: vi.fn(),
		unregister: vi.fn(),
		execute: vi.fn(async () => ({ success: true, output: 'should never run' })),
		get: vi.fn(() => undefined),
		has: vi.fn(() => true),
		listNames: vi.fn(() => []),
		getAvailability: vi.fn(),
	} as unknown as ToolRegistryContract
}

function response(): ChatCompletionResponse {
	return {
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'call_1',
					type: 'function',
					function: { name: 'write', arguments: '{"path":"/etc/passwd"}' },
				},
			],
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

describe('a tool call a probe vetoed', () => {
	let emitted: RunEvent[]
	let executor: ToolExecutor

	beforeEach(() => {
		emitted = []
		const probes = createProbeRegistry()
		probes.veto('tool_executing', () => ({ action: 'deny', reason: 'outside workspace' }), {
			name: 'sandbox',
		})

		executor = new ToolExecutor(
			{
				tools: makeToolRegistry(),
				runId: RUN_ID,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
			},
			new ActivityStore(RUN_ID, { enabled: true, trackToolCalls: true, trackLlmTurns: true }),
			async (e: RunEvent) => {
				emitted.push(e)
			},
			makeLogger(),
			probes,
		)
	})

	it('returns a result marked as an error', async () => {
		const batch = await executor.executeBatch(response())
		// Without this the model reads a successful result whose body begins
		// "Error: …", and the failure-recovery path it was trained on never
		// fires.
		expect(batch.results[0]?.isError).toBe(true)
	})

	it('agrees with the event it emitted for the same call', async () => {
		const batch = await executor.executeBatch(response())
		const completed = emitted.find((e) => e.type === 'tool_completed') as
			| { isError?: boolean }
			| undefined

		// These are produced five lines apart in the same function and
		// described the same call differently.
		expect(completed?.isError).toBe(true)
		expect(batch.results[0]?.isError).toBe(completed?.isError)
	})

	it('still explains itself in the output text', async () => {
		const batch = await executor.executeBatch(response())
		expect(batch.results[0]?.output).toContain('outside workspace')
	})

	it('never ran the tool', async () => {
		const batch = await executor.executeBatch(response())
		expect(batch.results[0]?.output).not.toContain('should never run')
	})

	it('leaves an allowed call unmarked', async () => {
		const probes = createProbeRegistry()
		const allowed = new ToolExecutor(
			{
				tools: makeToolRegistry(),
				runId: RUN_ID,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
			},
			new ActivityStore(RUN_ID, { enabled: true, trackToolCalls: true, trackLlmTurns: true }),
			async () => {},
			makeLogger(),
			probes,
		)

		const batch = await allowed.executeBatch(response())
		// The ordinary path must not have moved.
		expect(batch.results[0]?.isError).toBeFalsy()
	})
})
