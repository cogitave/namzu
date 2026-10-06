import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { AuthorizationGate } from '../../../authorization/gate.js'
import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { AuthorizationGateConfig } from '../../../types/authorization/index.js'
import type { HITLDecisionRequest } from '../../../types/hitl/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	generateTurnId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { turnCheckpoints } from './support/session.js'

afterEach(() => vi.restoreAllMocks())

function deferred() {
	let resolve!: () => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<void>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

function fixture(turns: MockTurn[], tools: ToolDefinition[] = []) {
	const provider = new MockLLMProvider({ turns })
	const sessionId = generateSessionId()
	const params = {
		provider,
		toolsets: tools.length ? [testToolset(...tools)] : [],
		agentId: 'async-preparation',
		agentName: 'Async preparation',
		messages: [{ role: 'user' as const, content: 'Run the requested local fixture' }],
		workingDirectory: process.cwd(),
		projectId: generateProjectId(),
		sessionId,
		tenantId: generateTenantId(),
		topicId: generateTopicId(),
		turnId: generateTurnId(),
		sessionLog: new InMemorySessionLog({ sessionId }),
		turnConfig: { model: 'mock', tokenBudget: 100_000, maxIterations: 4, timeoutMs: 0 },
		toolTimeoutMs: 0,
		repeatCallAdvisory: false,
	}
	return { provider, params }
}

const call = (name: string, args: Record<string, unknown>): MockTurn => ({
	toolCalls: [{ name, args }],
})

function policy(toolNames: string[], denyPush = false): AuthorizationGateConfig {
	return {
		enabled: true,
		rules: [
			...(denyPush
				? [
						{
							type: 'custom_pattern' as const,
							pattern: 'git push',
							target: 'args' as const,
							decision: 'deny' as const,
						},
					]
				: []),
			{ type: 'allow_by_name', toolNames },
		],
		allowReadOnlyTools: false,
		denyDangerousPatterns: false,
		logDecisions: false,
	}
}

const shellOptions = {
	name: 'shell',
	description: 'Local async preparation fixture with no shell backend',
	category: 'shell' as const,
	permissions: ['shell_execute' as const],
	readOnly: false,
	destructive: true,
	concurrencySafe: false,
}

describe('asynchronous tool preparation through the real query loop', () => {
	it('settles async structured output with one validation and one request', async () => {
		const refine = vi.fn(async () => {})
		const review = vi.fn(() => ({ accept: true as const }))
		const schema = z.object({ score: z.number() }).superRefine(refine)
		const f = fixture([call('structured_output', { score: 2 })])
		const run = await drainQuery({
			...f.params,
			structuredOutput: { schema, maxRetries: 0, review },
		})

		expect(run.structuredOutput).toEqual({ score: 2 })
		expect(run.stopReason).toBe('end_turn')
		expect(f.provider.requests).toHaveLength(1)
		expect(refine).toHaveBeenCalledOnce()
		expect(review).toHaveBeenCalledWith({ score: 2 }, expect.anything())
		expect(review).toHaveBeenCalledOnce()
	})

	it('charges an async schema rejection once without requesting a zero-allowance correction', async () => {
		const refine = vi.fn(async (_input: { score: number }, context: z.RefinementCtx) => {
			context.addIssue({ code: z.ZodIssueCode.custom, message: 'Score must be below ten' })
		})
		const schema = z.object({ score: z.number() }).superRefine(refine)
		const f = fixture([call('structured_output', { score: 99 })])
		const events: SessionEvent[] = []
		const run = await drainQuery(
			{ ...f.params, structuredOutput: { schema, maxRetries: 0 } },
			(event) => {
				events.push(event)
			},
		)

		expect(run.stopReason).toBe('structured_output_failed')
		expect(run.structuredOutput).toBeUndefined()
		expect(f.provider.requests).toHaveLength(1)
		expect(refine).toHaveBeenCalledOnce()
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'tool_completed', inputFailure: 'schema_validation' }),
		)
		expect((await turnCheckpoints(f.params)).at(-1)?.review.toolStructuredAttempts).toBe(1)
	})

	it('denies an asynchronously normalized dangerous value before execution', async () => {
		const transform = vi.fn(async () => ({ command: 'git push origin main' }))
		const execute = vi.fn(async () => ({ success: true, output: 'fixture executed' }))
		const tool = defineTool({
			...shellOptions,
			inputSchema: z.object({ command: z.string() }).transform(transform),
			execute,
		})
		const f = fixture([call('shell', { command: 'status' }), { text: 'done' }], [tool])
		const evaluate = vi.spyOn(AuthorizationGate.prototype, 'evaluate')
		await drainQuery({ ...f.params, authorizationGate: policy(['shell'], true) })

		expect(transform).toHaveBeenCalledOnce()
		expect(execute).not.toHaveBeenCalled()
		expect(evaluate).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: 'shell',
				toolInput: { command: 'git push origin main' },
			}),
		)
	})

	it('shows human review the detached async defaulted and transformed input', async () => {
		const transform = vi.fn(async (input: { command: string; attempts: number }) => ({
			...input,
			command: `normalized:${input.command}`,
		}))
		const execute = vi.fn(async () => ({ success: true, output: 'fixture executed' }))
		const tool = defineTool({
			...shellOptions,
			inputSchema: z
				.object({ command: z.string(), attempts: z.number().default(2) })
				.transform(transform),
			execute,
		})
		const f = fixture([call('shell', { command: 'status' }), { text: 'done' }], [tool])
		let request: HITLDecisionRequest | undefined
		await drainQuery({
			...f.params,
			authorizationGate: policy([]),
			resumeHandler: async (pending) => {
				if (pending.type === 'tool_review') {
					request = pending
					return { action: 'reject_tools', feedback: 'inspection complete' }
				}
				return { action: 'continue' }
			},
		})

		expect(request).toEqual(
			expect.objectContaining({
				type: 'tool_review',
				toolCalls: [
					expect.objectContaining({ input: { command: 'normalized:status', attempts: 2 } }),
				],
			}),
		)
		expect(transform).toHaveBeenCalledOnce()
		expect(execute).not.toHaveBeenCalled()
	})

	it('reuses one async preparation across execution retries', async () => {
		let parses = 0
		const transform = vi.fn(async ({ command }: { command: string }) => ({
			command: `${command}-${++parses}`,
		}))
		const executed: string[] = []
		const tool = defineTool({
			...shellOptions,
			inputSchema: z.object({ command: z.string() }).transform(transform),
			maxRetries: 1,
			execute: async ({ command }) => {
				executed.push(command)
				return executed.length === 1
					? { success: false, output: '', error: 'retry fixture', retryable: true }
					: { success: true, output: 'done' }
			},
		})
		const f = fixture([call('shell', { command: 'status' }), { text: 'done' }], [tool])
		await drainQuery({
			...f.params,
			authorizationGate: policy(['shell']),
			toolRetryBackoff: { initialDelayMs: 0, maxDelayMs: 0 },
		})

		expect(transform).toHaveBeenCalledOnce()
		expect(executed).toEqual(['status-1', 'status-1'])
	})

	it('revalidates a pre-tool rewrite asynchronously before authorization', async () => {
		const refine = vi.fn(async () => {})
		const execute = vi.fn(async () => ({ success: true, output: 'fixture executed' }))
		const tool = defineTool({
			...shellOptions,
			inputSchema: z.object({ command: z.string() }).superRefine(refine),
			execute,
		})
		const hooks = vi.fn(async (event: string) =>
			event === 'pre_tool_use'
				? [{ action: 'modify', input: { command: 'git push origin main' } }]
				: [],
		)
		const pluginManager = { executeHooks: hooks } as unknown as PluginLifecycleManager
		const f = fixture([call('shell', { command: 'status' }), { text: 'done' }], [tool])
		const evaluate = vi.spyOn(AuthorizationGate.prototype, 'evaluate')
		await drainQuery({ ...f.params, pluginManager, authorizationGate: policy(['shell'], true) })

		expect(refine).toHaveBeenCalledTimes(2)
		expect(hooks).toHaveBeenCalledWith(
			'pre_tool_use',
			expect.objectContaining({ toolInput: { command: 'status' } }),
			expect.any(Function),
		)
		expect(evaluate).toHaveBeenCalledWith(
			expect.objectContaining({ toolInput: { command: 'git push origin main' } }),
		)
		expect(execute).not.toHaveBeenCalled()
	})

	it.each(['resolve', 'reject'] as const)(
		'cancels held async validation before hooks or gates and ignores late %s',
		async (late) => {
			const entered = deferred()
			const release = deferred()
			const controller = new AbortController()
			const refine = vi.fn(async () => {
				entered.resolve()
				await release.promise
			})
			const schema = z.object({ score: z.number() }).superRefine(refine)
			const parse = schema.safeParseAsync.bind(schema)
			let validation: ReturnType<typeof schema.safeParseAsync> | undefined
			vi.spyOn(schema, 'safeParseAsync').mockImplementation((...args) => {
				validation = parse(...args)
				return validation
			})
			const hooks = vi.fn(async (_event: string, _context: { toolName?: string }) => [])
			const review = vi.fn(() => ({ accept: true as const }))
			const evaluate = vi.spyOn(AuthorizationGate.prototype, 'evaluate')
			const executePrepared = vi.spyOn(ToolManager.prototype, 'executePrepared')
			const f = fixture([call('structured_output', { score: 2 }), { text: 'unreachable' }])
			const events: SessionEvent[] = []
			const pending = drainQuery(
				{
					...f.params,
					signal: controller.signal,
					structuredOutput: { schema, maxRetries: 0, review },
					pluginManager: { executeHooks: hooks } as unknown as PluginLifecycleManager,
					authorizationGate: policy(['structured_output']),
				},
				(event) => {
					events.push(event)
				},
			)
			await entered.promise
			controller.abort(new Error('stop during validation'))
			const run = await pending
			expect(run.status).toBe('cancelled')
			expect(run.structuredOutput).toBeUndefined()
			expect(f.provider.requests).toHaveLength(1)
			expect(refine).toHaveBeenCalledOnce()
			expect(evaluate).not.toHaveBeenCalled()
			expect(hooks.mock.calls.filter(([event]) => event === 'pre_tool_use')).toHaveLength(0)
			expect(review).not.toHaveBeenCalled()
			expect(executePrepared).not.toHaveBeenCalled()
			expect((await turnCheckpoints(f.params)).at(-1)?.review.toolStructuredAttempts ?? 0).toBe(0)
			const eventCount = events.length
			if (late === 'resolve') release.resolve()
			else release.reject(new Error('late validator rejection'))
			await validation?.catch(() => undefined)
			expect(events).toHaveLength(eventCount)
			expect(f.provider.requests).toHaveLength(1)
			expect(review).not.toHaveBeenCalled()
		},
	)

	it('prepares detached raw JSON once for nested async dispatch', async () => {
		const entered = deferred()
		const release = deferred()
		const raw = { command: 'status', nested: { force: false } }
		const refine = vi.fn(async () => {
			entered.resolve()
			await release.promise
		})
		const executed: unknown[] = []
		const child = defineTool({
			...shellOptions,
			inputSchema: z.any().superRefine(refine),
			execute: async (input) => {
				executed.push(input)
				return { success: true, output: 'nested fixture ran' }
			},
		})
		const parent = defineTool({
			name: 'parent',
			description: 'Dispatch the nested local fixture',
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: true,
			concurrencySafe: false,
			timeoutMs: 0,
			execute: async (_input, context) => {
				const pending = context.dispatchTool?.('shell', raw)
				await entered.promise
				raw.command = 'git push origin main'
				raw.nested.force = true
				release.resolve()
				return (await pending) ?? { success: false, output: 'dispatch unavailable' }
			},
		})
		const f = fixture([call('parent', {}), { text: 'done' }], [parent, child])
		const run = await drainQuery({
			...f.params,
			authorizationGate: policy(['parent', 'shell'], true),
		})

		expect(run.stopReason).toBe('end_turn')
		expect(refine).toHaveBeenCalledOnce()
		expect(executed).toEqual([{ command: 'status', nested: { force: false } }])
		expect(executed[0]).not.toBe(raw)
	})

	it('cancels nested async preparation with the turn before child hooks, gates or execution', async () => {
		const entered = deferred()
		const release = deferred()
		const controller = new AbortController()
		const refine = vi.fn(async () => {
			entered.resolve()
			await release.promise
		})
		const execute = vi.fn(async () => ({ success: true, output: 'unreachable child' }))
		const schema = z.object({ command: z.string() }).superRefine(refine)
		const parse = schema.safeParseAsync.bind(schema)
		let validation: ReturnType<typeof schema.safeParseAsync> | undefined
		vi.spyOn(schema, 'safeParseAsync').mockImplementation((...args) => {
			validation = parse(...args)
			return validation
		})
		const child = defineTool({
			...shellOptions,
			inputSchema: schema,
			execute,
		})
		const parent = defineTool({
			name: 'parent',
			description: 'Await the nested local fixture',
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: true,
			concurrencySafe: false,
			timeoutMs: 0,
			execute: async (_input, context) =>
				(await context.dispatchTool?.('shell', { command: 'status' })) ?? {
					success: false,
					output: 'dispatch unavailable',
				},
		})
		const hooks = vi.fn(async (_event: string, _context: { toolName?: string }) => [])
		const evaluate = vi.spyOn(AuthorizationGate.prototype, 'evaluate')
		const f = fixture([call('parent', {}), { text: 'unreachable' }], [parent, child])
		const events: SessionEvent[] = []
		const pending = drainQuery(
			{
				...f.params,
				signal: controller.signal,
				pluginManager: { executeHooks: hooks } as unknown as PluginLifecycleManager,
				authorizationGate: policy(['parent', 'shell']),
			},
			(event) => {
				events.push(event)
			},
		)
		await entered.promise
		controller.abort(new Error('stop nested validation'))
		const run = await pending
		expect(run.status).toBe('cancelled')
		expect(f.provider.requests).toHaveLength(1)
		expect(refine).toHaveBeenCalledOnce()
		expect(execute).not.toHaveBeenCalled()
		expect(evaluate.mock.calls.filter(([context]) => context.toolName === 'shell')).toHaveLength(0)
		expect(
			hooks.mock.calls.filter(
				([event, context]) => event === 'pre_tool_use' && context.toolName === 'shell',
			),
		).toHaveLength(0)
		const eventCount = events.length
		release.resolve()
		await validation?.catch(() => undefined)
		expect(events).toHaveLength(eventCount)
		expect(execute).not.toHaveBeenCalled()
		expect(f.provider.requests).toHaveLength(1)
	})
})
