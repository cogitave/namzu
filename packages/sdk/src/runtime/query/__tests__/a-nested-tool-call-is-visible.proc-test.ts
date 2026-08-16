import { describe, expect, it, vi } from 'vitest'

import { ActivityStore } from '../../../store/activity/memory.js'
import { buildRunCodeTool } from '../../../tools/builtins/run-code.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ToolContext, ToolRegistryContract } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor } from '../executor.js'

/**
 * A tool call a PROGRAM made, visible in the run's own stream.
 *
 * `run_code` dispatches through the registry, and that dispatch reached the
 * permission gate and reached the event stream not at all. A run whose
 * transcript showed one `run_code` call and nothing about the eleven writes
 * it performed is a transcript nobody can audit — the tool would be the one
 * place in the system where work happens off the record.
 *
 * Process-level: the program runs in a real worker thread.
 */

const RUN_ID = 'run_nested' as RunId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function registryWith(runCode: ReturnType<typeof buildRunCodeTool>): ToolRegistryContract {
	return {
		register: vi.fn(),
		unregister: vi.fn(),
		execute: vi.fn(async (name: string, input: unknown, context: ToolContext) => {
			if (name === 'run_code') return await runCode.execute(input as never, context)
			return { success: true, output: `${name} ran` }
		}),
		get: vi.fn(() => undefined),
		has: vi.fn(() => true),
		listNames: vi.fn(() => []),
		getAvailability: vi.fn(),
	} as unknown as ToolRegistryContract
}

async function runProgram(code: string, tools: string[]): Promise<RunEvent[]> {
	const emitted: RunEvent[] = []
	const executor = new ToolExecutor(
		{
			tools: registryWith(buildRunCodeTool({ timeoutMs: 5_000 })),
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
	)

	await executor.executeBatch({
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'call_parent',
					type: 'function',
					function: { name: 'run_code', arguments: JSON.stringify({ code, tools }) },
				},
			],
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse)

	return emitted
}

const nested = (events: RunEvent[], type: string) =>
	events.filter((e) => e.type === type && (e as { via?: unknown }).via !== undefined)

describe('a tool call a program made reaches the event stream', () => {
	it('emits a start and a completion for each one', async () => {
		const events = await runProgram('await call("write", { path: "a" }); return 1', ['write'])

		expect(nested(events, 'tool_executing')).toHaveLength(1)
		expect(nested(events, 'tool_completed')).toHaveLength(1)
	})

	it('emits one pair per call in a loop', async () => {
		// The case that motivates all of this: eleven writes behind one
		// `run_code` call.
		const events = await runProgram(
			'for (const p of ["a","b","c"]) await call("write", { path: p }); return 1',
			['write'],
		)

		expect(nested(events, 'tool_executing')).toHaveLength(3)
	})

	it('names the tool and carries the input', async () => {
		const events = await runProgram('await call("write", { path: "a.txt" }); return 1', ['write'])
		const start = nested(events, 'tool_executing')[0] as { toolName: string; input: unknown }

		expect(start.toolName).toBe('write')
		expect(start.input).toEqual({ path: 'a.txt' })
	})
})

describe('a nested call is distinguishable from a model-issued one', () => {
	it('marks the nested ones and leaves the parent unmarked', async () => {
		// Without this a consumer counting tool calls double-counts the parent
		// AND each child, and one rendering a timeline draws siblings where
		// there is a parent with children.
		const events = await runProgram('await call("write", {}); return 1', ['write'])
		const starts = events.filter((e) => e.type === 'tool_executing')

		expect(starts).toHaveLength(2)
		expect(starts.filter((e) => (e as { via?: unknown }).via === undefined)).toHaveLength(1)
		expect(starts.filter((e) => (e as { via?: unknown }).via !== undefined)).toHaveLength(1)
	})

	it('gives a nested call its OWN id, not the parent’s', async () => {
		// Reusing the parent's id makes two different calls indistinguishable
		// in any log keyed by it — which is exactly how a nested write gets
		// attributed to the program that ran it rather than to itself.
		const events = await runProgram('await call("write", {}); return 1', ['write'])
		const start = nested(events, 'tool_executing')[0] as { toolUseId: string }

		expect(start.toolUseId).not.toBe('call_parent')
	})

	it('pairs its start and completion by that id', async () => {
		const events = await runProgram('await call("write", {}); return 1', ['write'])
		const start = nested(events, 'tool_executing')[0] as { toolUseId: string }
		const done = nested(events, 'tool_completed')[0] as { toolUseId: string }

		expect(done.toolUseId).toBe(start.toolUseId)
	})

	it('carries `via` on the completion too, so a consumer need not hold the start', async () => {
		const events = await runProgram('await call("write", {}); return 1', ['write'])

		expect((nested(events, 'tool_completed')[0] as { via: unknown }).via).toBeDefined()
	})
})

describe('a nested failure is reported as one', () => {
	it('marks it as an error rather than a quiet success', async () => {
		const emitted: RunEvent[] = []
		const runCode = buildRunCodeTool({ timeoutMs: 5_000 })
		const executor = new ToolExecutor(
			{
				tools: {
					register: vi.fn(),
					unregister: vi.fn(),
					execute: vi.fn(async (name: string, input: unknown, context: ToolContext) => {
						if (name === 'run_code') return await runCode.execute(input as never, context)
						return { success: false, output: '', error: 'the tool refused' }
					}),
					get: vi.fn(() => undefined),
					has: vi.fn(() => true),
					listNames: vi.fn(() => []),
					getAvailability: vi.fn(),
				} as unknown as ToolRegistryContract,
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
		)

		await executor.executeBatch({
			message: {
				role: 'assistant',
				content: null,
				toolCalls: [
					{
						id: 'call_parent',
						type: 'function',
						function: {
							name: 'run_code',
							arguments: JSON.stringify({
								code: 'try { await call("write", {}) } catch {}; return 1',
								tools: ['write'],
							}),
						},
					},
				],
			},
			finishReason: 'tool_calls',
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		} as ChatCompletionResponse)

		const done = nested(emitted, 'tool_completed')[0] as { isError: boolean; result: string }
		expect(done.isError).toBe(true)
		expect(done.result).toContain('the tool refused')
	})

	it('reports nothing for a call the program was refused', async () => {
		// It never reached a tool, so there is no tool call to record. An
		// event here would put a call in the transcript that never happened.
		const events = await runProgram('try { await call("bash", {}) } catch {}; return 1', ['write'])

		expect(nested(events, 'tool_executing')).toHaveLength(0)
	})
})
