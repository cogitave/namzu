import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ToolRegistry } from '../../../registry/tool/execute.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import { buildRunCodeTool } from '../../../tools/builtins/run-code.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type {
	RequestToolPause,
	ToolContext,
	ToolRegistryContract,
	ToolResult,
} from '../../../types/tool/index.js'
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
	return {
		...stub,
		child: vi.fn(() => ({ ...stub, child: vi.fn() })),
	} as unknown as Logger
}

interface ProgramHarnessOptions {
	readonly childExecute?: (
		name: string,
		input: unknown,
		context: ToolContext,
	) => Promise<ToolResult>
	readonly maxToolOutputChars?: number
	readonly childTimeoutMs?: number
	readonly runCodeTimeoutMs?: number
	readonly toolTimeoutMs?: number
	readonly toolPause?: (toolUseId: string) => RequestToolPause
	readonly additionalTools?: readonly string[]
	readonly observeParentContext?: (context: ToolContext) => void
}

function registryWith(
	runCode: ReturnType<typeof buildRunCodeTool>,
	toolNames: readonly string[],
	options: ProgramHarnessOptions,
): ToolRegistryContract {
	const registry = new ToolRegistry()
	registry.register(
		options.observeParentContext
			? {
					...runCode,
					async execute(input, context) {
						options.observeParentContext?.(context)
						return await runCode.execute(input as never, context)
					},
				}
			: runCode,
	)
	for (const name of new Set([...toolNames, ...(options.additionalTools ?? [])])) {
		registry.register(
			defineTool({
				name,
				description: `Test ${name}`,
				inputSchema: z.record(z.unknown()),
				category: 'custom',
				permissions: [],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				...(options.childTimeoutMs !== undefined ? { timeoutMs: options.childTimeoutMs } : {}),
				async execute(input, context) {
					return options.childExecute
						? await options.childExecute(name, input, context)
						: { success: true, output: `${name} ran` }
				},
			}),
		)
	}
	return registry
}

async function runProgram(
	code: string,
	tools: string[],
	options: ProgramHarnessOptions = {},
): Promise<RunEvent[]> {
	const emitted: RunEvent[] = []
	const executor = new ToolExecutor(
		{
			tools: registryWith(
				buildRunCodeTool({ timeoutMs: options.runCodeTimeoutMs ?? 5_000 }),
				tools,
				options,
			),
			runId: RUN_ID,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			...(options.maxToolOutputChars !== undefined
				? { maxToolOutputChars: options.maxToolOutputChars }
				: {}),
			...(options.toolTimeoutMs !== undefined ? { toolTimeoutMs: options.toolTimeoutMs } : {}),
			...(options.toolPause ? { toolPause: options.toolPause } : {}),
		},
		new ActivityStore(RUN_ID, {
			enabled: true,
			trackToolCalls: true,
			trackLlmTurns: true,
		}),
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
						arguments: JSON.stringify({ code, tools }),
					},
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
		const start = nested(events, 'tool_executing')[0] as {
			toolName: string
			input: unknown
		}

		expect(start.toolName).toBe('write')
		expect(start.input).toEqual({ path: 'a.txt' })
	})
})

describe('a nested call is distinguishable from a model-issued one', () => {
	it('marks a model-issued parent as direct', async () => {
		let parentContext: ToolContext | undefined
		await runProgram('return 1', [], {
			observeParentContext: (context) => {
				parentContext = context
			},
		})

		expect(parentContext).toMatchObject({
			toolUseId: 'call_parent',
			source: { kind: 'direct' },
		})
	})

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

	it('gives the child its own execution identity while retaining the durable ancestor pause route', async () => {
		const contexts: ToolContext[] = []
		const pauseIds: string[] = []
		const events = await runProgram('return await call("write", {})', ['write'], {
			childExecute: async (_name, _input, context) => {
				contexts.push(context)
				context.report?.('child reached the gate', 0.5)
				await context.requestPause?.({
					name: 'confirm',
					prompt: 'Continue?',
				})
				return { success: true, output: 'written' }
			},
			toolPause: (toolUseId) => {
				pauseIds.push(toolUseId)
				return async () => ({ status: 'unanswered', reason: 'test' })
			},
		})
		const start = nested(events, 'tool_executing')[0] as Extract<
			RunEvent,
			{ type: 'tool_executing' }
		>

		expect(contexts).toHaveLength(1)
		expect(contexts[0]).toMatchObject({
			toolUseId: start.toolUseId,
			source: {
				kind: 'code',
				parentToolUseId: 'call_parent',
				runtimeToolCallId: '1',
			},
		})
		expect(start.via).toEqual({
			tool: 'run_code',
			toolUseId: 'call_parent',
			runtimeToolCallId: '1',
		})
		// The checkpoint transcript contains `call_parent`, not this
		// executor-minted child id. Binding the pause to the child would make
		// a cross-process answer impossible to route on re-entry.
		expect(pauseIds).toEqual(['call_parent'])
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'tool_progress',
				toolUseId: start.toolUseId,
				toolName: 'write',
				message: 'child reached the gate',
				fraction: 0.5,
			}),
		)
	})

	it('parents a grandchild to the child that actually dispatched it', async () => {
		const contexts = new Map<string, ToolContext>()
		const events = await runProgram('return await call("chain", {})', ['chain'], {
			additionalTools: ['leaf'],
			childExecute: async (name, _input, context) => {
				contexts.set(name, context)
				if (name === 'chain') {
					if (!context.dispatchTool) throw new Error('missing nested dispatch')
					return await context.dispatchTool('leaf', {})
				}
				return { success: true, output: 'leaf result' }
			},
		})
		const starts = nested(events, 'tool_executing') as Extract<
			RunEvent,
			{ type: 'tool_executing' }
		>[]
		const chain = starts.find((event) => event.toolName === 'chain')
		const leaf = starts.find((event) => event.toolName === 'leaf')

		expect(chain).toBeDefined()
		expect(leaf?.via).toEqual({ tool: 'chain', toolUseId: chain?.toolUseId })
		expect(contexts.get('leaf')?.source).toEqual({
			kind: 'nested',
			parentToolUseId: chain?.toolUseId,
		})
	})

	it('bounds a child response before it crosses back into the program', async () => {
		const huge = `HEAD-${'x'.repeat(500)}-TAIL`
		const events = await runProgram('return await call("read", {})', ['read'], {
			maxToolOutputChars: 80,
			childExecute: async () => ({ success: true, output: huge }),
		})
		const done = nested(events, 'tool_completed')[0] as Extract<
			RunEvent,
			{ type: 'tool_completed' }
		>

		expect(done.outputLength).toBe(huge.length)
		expect(done.outputTruncated).toBe(true)
		expect(done.result).not.toBe(huge)
		expect(done.result).toContain('omitted')
	})

	it('bounds a failed child response before it crosses back into the program', async () => {
		const hugeError = `FAIL-${'y'.repeat(500)}-TAIL`
		const events = await runProgram(
			'try { await call("read", {}) } catch (error) { return error.message }',
			['read'],
			{
				maxToolOutputChars: 80,
				childExecute: async () => ({
					success: false,
					output: '',
					error: hugeError,
				}),
			},
		)
		const done = nested(events, 'tool_completed')[0] as Extract<
			RunEvent,
			{ type: 'tool_completed' }
		>

		expect(done.outputLength).toBe(`Error: ${hugeError}`.length)
		expect(done.outputTruncated).toBe(true)
		expect(done.result).not.toContain(hugeError)
		expect(done.result).toContain('omitted')
	})

	it('honours a child tool deadline independently of the program deadline', async () => {
		let childSignal: AbortSignal | undefined
		const events = await runProgram('return await call("slow", {})', ['slow'], {
			runCodeTimeoutMs: 1_000,
			toolTimeoutMs: 1_000,
			childTimeoutMs: 70,
			childExecute: async (_name, _input, context) => {
				childSignal = context.abortSignal
				await new Promise<void>(() => {})
				return { success: true, output: 'unreachable' }
			},
		})
		const childDone = nested(events, 'tool_completed')[0] as Extract<
			RunEvent,
			{ type: 'tool_completed' }
		>

		expect(childSignal?.aborted).toBe(true)
		expect(childDone.isError).toBe(true)
		expect(childDone.result).toContain('timed out after 70ms')
	})

	it('revokes a cooperative child when the program deadline wins', async () => {
		let childSignal: AbortSignal | undefined
		const events = await runProgram('return await call("slow", {})', ['slow'], {
			runCodeTimeoutMs: 80,
			toolTimeoutMs: 250,
			childExecute: async (_name, _input, context) => {
				childSignal = context.abortSignal
				await new Promise<void>((resolve) => {
					if (context.abortSignal.aborted) resolve()
					else
						context.abortSignal.addEventListener('abort', () => resolve(), {
							once: true,
						})
				})
				return { success: false, output: '', error: 'child cancelled' }
			},
		})

		expect(childSignal?.aborted).toBe(true)
		expect(childSignal?.reason).toEqual(new Error('Code runtime exceeded 80ms'))
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'tool_completed',
				toolUseId: 'call_parent',
				isError: true,
				result: expect.stringContaining('ran longer than 80ms'),
			}),
		)
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
			new ActivityStore(RUN_ID, {
				enabled: true,
				trackToolCalls: true,
				trackLlmTurns: true,
			}),
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

		const done = nested(emitted, 'tool_completed')[0] as {
			isError: boolean
			result: string
		}
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
