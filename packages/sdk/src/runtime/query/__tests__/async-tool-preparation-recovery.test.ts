import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { AuthorizationGate } from '../../../authorization/gate.js'
import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { AuthorizationGateConfig } from '../../../types/authorization/index.js'
import type { HITLDecisionRequest, ResumeHandler } from '../../../types/hitl/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { resumeSession } from '../resume-session.js'
import { loadTurnState } from '../turn-state.js'
import { heldCheckpointStore, memorySession, records, rewriteSession } from './support/session.js'

afterEach(() => vi.restoreAllMocks())

function reopen(log: InMemorySessionLog): InMemorySessionLog {
	return new InMemorySessionLog({
		sessionId: log.sessionId,
		medium: log.medium,
		leases: log.leaseStore,
		spills: log.spillStore,
	})
}

function fixture() {
	return {
		...memorySession(),
		turnId: generateTurnId(),
		agentId: 'async-preparation-recovery',
		agentName: 'Async preparation recovery',
		workingDirectory: process.cwd(),
		turnConfig: { model: 'mock', tokenBudget: 100_000, maxIterations: 4, timeoutMs: 0 },
		toolTimeoutMs: 0,
		repeatCallAdvisory: false,
	}
}

const pauseOnReview: ResumeHandler = async (request) =>
	request.type === 'tool_review'
		? { action: 'pause', reason: 'waiting for a human' }
		: { action: 'continue' }

const reviewPolicy: AuthorizationGateConfig = {
	enabled: true,
	rules: [],
	allowReadOnlyTools: false,
	denyDangerousPatterns: false,
	logDecisions: false,
}

async function parkedState(f: ReturnType<typeof fixture>) {
	const log = reopen(f.sessionLog)
	const state = await loadTurnState(log, await heldCheckpointStore(log), f)
	if (state?.pending?.request.type !== 'tool_review') throw new Error('Expected a durable review')
	return { log, state }
}

function normalizedTool(
	transform: (input: { value: string; count: number }) => Promise<{ value: string; count: number }>,
	execute: (input: { value: string; count: number }) => Promise<{
		success: boolean
		output: string
	}>,
) {
	return defineTool({
		name: 'normalize',
		description: 'Async normalization recovery fixture',
		inputSchema: z.object({ value: z.string(), count: z.number().default(2) }).transform(transform),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: true,
		concurrencySafe: false,
		execute,
	})
}

describe('asynchronous preparation across a durable pending batch', () => {
	it.each(['v1', 'v2'] as const)(
		'revalidates a normalized approval against the resumed schema %s',
		async (version) => {
			const f = fixture()
			const firstTransform = vi.fn(async (input: { value: string; count: number }) => ({
				...input,
				value: `v1:${input.value}`,
			}))
			const execute = vi.fn(async (input: { value: string; count: number }) => ({
				success: true,
				output: input.value,
			}))
			const first = new MockLLMProvider({
				turns: [
					{ toolCalls: [{ id: 'normalized-call', name: 'normalize', args: { value: 'x' } }] },
				],
			})
			const parked = await drainQuery({
				...f,
				provider: first,
				toolsets: [testToolset(normalizedTool(firstTransform, execute))],
				messages: [{ role: 'user', content: 'Normalize x' }],
				authorizationGate: reviewPolicy,
				resumeHandler: pauseOnReview,
			})
			expect(parked.stopReason).toBe('paused')
			expect(firstTransform).toHaveBeenCalledOnce()
			expect(execute).not.toHaveBeenCalled()
			const { log, state } = await parkedState(f)
			expect(state.pending?.request).toMatchObject({
				type: 'tool_review',
				toolCalls: [{ id: 'normalized-call', input: { value: 'v1:x', count: 2 } }],
			})
			const secondTransform = vi.fn(async (input: { value: string; count: number }) => ({
				...input,
				value: `${version}:${input.value}`,
			}))
			const second = new MockLLMProvider({ turns: [{ text: 'settled' }] })
			const review = vi.fn(async (_request: HITLDecisionRequest) => ({
				action: 'continue' as const,
			}))
			const resumed = await drainQuery({
				...f,
				sessionLog: log,
				provider: second,
				toolsets: [testToolset(normalizedTool(secondTransform, execute))],
				messages: [],
				resumeFromCheckpoint: state.checkpointId,
				pendingDecision: { action: 'approve_tools' },
				authorizationGate: reviewPolicy,
				resumeHandler: review,
			})

			expect(resumed.stopReason).toBe('end_turn')
			expect(secondTransform).toHaveBeenCalledOnce()
			expect(firstTransform).toHaveBeenCalledOnce()
			expect(review.mock.calls.filter(([request]) => request.type === 'tool_review')).toHaveLength(
				0,
			)
			expect(second.requests).toHaveLength(1)
			const results = second.requests[0]?.messages.filter((message) => message.role === 'tool')
			if (version === 'v1') {
				expect(execute).toHaveBeenCalledOnce()
				expect(execute).toHaveBeenCalledWith({ value: 'v1:x', count: 2 }, expect.anything())
				expect(JSON.stringify(results)).not.toMatch(/changed after its durable review/i)
			} else {
				expect(execute).not.toHaveBeenCalled()
				expect(JSON.stringify(results)).toMatch(/changed after its durable review/i)
			}
		},
	)

	it('never reparses completed or denied siblings when recovering the unanswered async call', async () => {
		const f = fixture()
		const calls: MockTurn[] = [
			{
				toolCalls: [
					{ id: 'finished-call', name: 'finished', args: {} },
					{ id: 'denied-call', name: 'denied', args: {} },
					{ id: 'pending-call', name: 'pending', args: {} },
				],
			},
			{ text: 'done' },
		]
		const firstParses = {
			finished: vi.fn(async () => {}),
			denied: vi.fn(async () => {}),
			pending: vi.fn(async () => {}),
		}
		const firstEffects = { finished: vi.fn(), denied: vi.fn(), pending: vi.fn() }
		const tools = (parses: typeof firstParses, effects: typeof firstEffects): ToolDefinition[] =>
			(['finished', 'denied', 'pending'] as const).map((name) =>
				defineTool({
					name,
					description: `${name} recovery fixture`,
					inputSchema: z.object({}).superRefine(parses[name]),
					category: 'custom',
					permissions: [],
					readOnly: false,
					destructive: true,
					concurrencySafe: false,
					executionBarrier: true,
					execute: async () => {
						effects[name]()
						return { success: true, output: `${name} receipt` }
					},
				}),
			)
		const policy: AuthorizationGateConfig = {
			...reviewPolicy,
			rules: [
				{ type: 'custom_pattern', pattern: '^denied$', target: 'name', decision: 'deny' },
				{ type: 'allow_by_name', toolNames: ['finished', 'pending'] },
			],
		}
		await drainQuery({
			...f,
			provider: new MockLLMProvider({ turns: calls }),
			toolsets: [testToolset(...tools(firstParses, firstEffects))],
			messages: [{ role: 'user', content: 'Run the mixed batch' }],
			authorizationGate: policy,
			reviewAllowedCalls: () => true,
			resumeHandler: async () => ({ action: 'approve_tools' }),
		})
		expect(firstEffects.finished).toHaveBeenCalledOnce()
		expect(firstEffects.denied).not.toHaveBeenCalled()
		expect(firstEffects.pending).toHaveBeenCalledOnce()
		const log = await rewriteSession(f.sessionLog, [f], (draft) => draft, {
			through: (draft) => draft.type === 'tool_completed' && draft.toolUseId === 'denied-call',
		})
		expect(
			(await records(log))
				.filter((record) => record.type === 'tool_completed')
				.map((record) => record.toolUseId),
		).toEqual(['finished-call', 'denied-call'])
		const secondParses = {
			finished: vi.fn(async () => {}),
			denied: vi.fn(async () => {}),
			pending: vi.fn(async () => {}),
		}
		const secondEffects = { finished: vi.fn(), denied: vi.fn(), pending: vi.fn() }
		const provider = new MockLLMProvider({ turns: [{ text: 'recovered' }] })
		const outcome = await resumeSession({
			...f,
			scope: f,
			sessionLog: log,
			checkpointStore: await heldCheckpointStore(log),
			provider,
			toolsets: [testToolset(...tools(secondParses, secondEffects))],
			authorizationGate: policy,
			pendingDecision: { action: 'approve_tools' },
			resumeHandler: async () => ({ action: 'continue' }),
		})

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) throw new Error('Expected the interrupted mixed batch to resume')
		expect(outcome.turn.stopReason).toBe('end_turn')
		expect(secondParses.finished).not.toHaveBeenCalled()
		expect(secondParses.denied).not.toHaveBeenCalled()
		expect(secondParses.pending).toHaveBeenCalledOnce()
		expect(secondEffects.finished).not.toHaveBeenCalled()
		expect(secondEffects.denied).not.toHaveBeenCalled()
		expect(secondEffects.pending).toHaveBeenCalledOnce()
		expect(provider.requests).toHaveLength(1)
		expect(
			provider.requests[0]?.messages.filter((message) => message.role === 'tool'),
		).toHaveLength(3)
	})

	it('cancels resumed async validation before any gate, review, execution or provider request', async () => {
		const f = fixture()
		const execute = vi.fn(async () => ({ success: true, output: 'unreachable' }))
		const first = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'normalize', args: { value: 'x' } }] }],
		})
		await drainQuery({
			...f,
			provider: first,
			toolsets: [testToolset(normalizedTool(async (input) => input, execute))],
			messages: [{ role: 'user', content: 'Normalize x' }],
			authorizationGate: reviewPolicy,
			resumeHandler: pauseOnReview,
		})
		const { log, state } = await parkedState(f)
		let enter!: () => void
		const entered = new Promise<void>((resolve) => {
			enter = resolve
		})
		let release!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		const transform = vi.fn(async (input: { value: string; count: number }) => {
			enter()
			await held
			return input
		})
		const tool = normalizedTool(transform, execute)
		const parse = tool.inputSchema.safeParseAsync.bind(tool.inputSchema)
		let validation: ReturnType<typeof tool.inputSchema.safeParseAsync> | undefined
		vi.spyOn(tool.inputSchema, 'safeParseAsync').mockImplementation((...args) => {
			validation = parse(...args)
			return validation
		})
		const evaluate = vi.spyOn(AuthorizationGate.prototype, 'evaluate')
		const hooks = vi.fn(async (_event: string, _context: { toolName?: string }) => [])
		const review = vi.fn(async (_request: HITLDecisionRequest) => ({ action: 'continue' as const }))
		const provider = new MockLLMProvider({ turns: [{ text: 'unreachable' }] })
		const events: SessionEvent[] = []
		const controller = new AbortController()
		const pending = drainQuery(
			{
				...f,
				sessionLog: log,
				provider,
				toolsets: [testToolset(tool)],
				messages: [],
				resumeFromCheckpoint: state.checkpointId,
				pendingDecision: { action: 'approve_tools' },
				authorizationGate: reviewPolicy,
				resumeHandler: review,
				pluginManager: { executeHooks: hooks } as unknown as PluginLifecycleManager,
				signal: controller.signal,
			},
			(event) => {
				events.push(event)
			},
		)
		await entered
		controller.abort(new Error('stop pending recovery validation'))
		const resumed = await pending
		expect(resumed.status).toBe('cancelled')
		expect(transform).toHaveBeenCalledOnce()
		expect(evaluate).not.toHaveBeenCalled()
		expect(hooks.mock.calls.filter(([event]) => event === 'pre_tool_use')).toHaveLength(0)
		expect(review).not.toHaveBeenCalled()
		expect(execute).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(0)
		const eventCount = events.length
		release()
		await validation?.catch(() => undefined)
		expect(events).toHaveLength(eventCount)
		expect(execute).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(0)
	})
})
