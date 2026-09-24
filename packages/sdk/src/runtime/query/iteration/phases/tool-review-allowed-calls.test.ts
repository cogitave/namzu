import { describe, expect, it, vi } from 'vitest'

import { AuthorizationGate } from '../../../../authorization/gate.js'
import { ActivityStore } from '../../../../store/activity/memory.js'
import type { AuthorizationGateConfig } from '../../../../types/authorization/index.js'
import type { HITLDecisionRequest, HITLResumeDecision } from '../../../../types/hitl/index.js'
import type { TurnId } from '../../../../types/ids/index.js'
import type { Message } from '../../../../types/message/index.js'
import { PLAN_MODE_REFUSAL } from '../../../../types/permission/index.js'
import type { ChatCompletionResponse } from '../../../../types/provider/index.js'
import type { ToolRegistryContract } from '../../../../types/tool/index.js'
import { generateSessionId } from '../../../../utils/id.js'
import type { Logger } from '../../../../utils/logger.js'
import { ToolExecutor } from '../../executor.js'
import { createReviewHandler } from '../../review-policy.js'
import { ToolGrantSet } from '../../tool-grants.js'
import type { IterationContext } from './context.js'
import { runToolReview } from './tool-review.js'

/**
 * `reviewAllowedCalls`: a batch a rule allows, or a grant covers, reaches the
 * review handler when the host says its policy is stricter than the rules.
 *
 * The defect this pins: a turn in plan mode with `permissions: { bash:
 * 'allow' }` ran `touch in-plan.txt`, because the batch never reached the
 * handler that knew about plan mode.
 */

const SESSION_ID = generateSessionId()
const TURN_ID = '0b2c3a8e-5d1f-4f7e-9a61-3c0e8b6d2f10' as TurnId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function bashResponse(command = 'touch in-plan.txt'): ChatCompletionResponse {
	return {
		id: 'resp_1',
		model: 'test',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'call_bash',
					type: 'function',
					function: { name: 'bash', arguments: JSON.stringify({ command }) },
				},
			],
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

function gateConfig(partial: Partial<AuthorizationGateConfig>): AuthorizationGateConfig {
	return {
		enabled: true,
		rules: [],
		allowReadOnlyTools: true,
		denyDangerousPatterns: true,
		logDecisions: false,
		...partial,
	}
}

const ALLOW_BASH = gateConfig({ rules: [{ type: 'allow_by_name', toolNames: ['bash'] }] })

function harness(opts: {
	gate?: AuthorizationGateConfig
	reviewAllowedCalls?: () => boolean
	handler?: (request: HITLDecisionRequest) => Promise<HITLResumeDecision>
	grants?: ToolGrantSet
}) {
	const executed: string[] = []
	const messages: Message[] = []
	const seen: HITLDecisionRequest[] = []
	const log = makeLogger()
	const tools = {
		get: vi.fn((name: string) =>
			name === 'bash'
				? {
						name,
						category: 'shell',
						isReadOnly: () => false,
						isDestructive: () => false,
						isConcurrencySafe: () => false,
					}
				: undefined,
		),
		execute: vi.fn(async (name: string) => {
			executed.push(name)
			return { success: true, output: `${name} ok` }
		}),
		has: vi.fn(() => true),
		sourceOf: vi.fn(() => ({ id: 'host', kind: 'host_tool' as const })),
		listNames: vi.fn(() => ['bash']),
		getAvailability: vi.fn(() => 'active'),
		register: vi.fn(),
		unregister: vi.fn(),
	} as unknown as ToolRegistryContract
	const toolExecutor = new ToolExecutor(
		{
			sessionId: SESSION_ID,
			tools,
			turnId: TURN_ID,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
		},
		new ActivityStore(TURN_ID, { enabled: true, trackToolCalls: true, trackLlmTurns: true }),
		async () => {},
		log,
	)
	const handler = opts.handler ?? (async () => ({ action: 'approve_tools' }) as HITLResumeDecision)
	const ctx = {
		tools,
		toolExecutor,
		log,
		abortController: new AbortController(),
		recorder: {
			id: TURN_ID,
			messages,
			pushMessage: (m: Message) => {
				messages.push(m)
			},
			setStopReason: vi.fn(),
			markCancelled: vi.fn(),
			recordAudit: vi.fn(async () => undefined),
		},
		checkpointMgr: { create: async () => ({ id: '62d8ff8a-122d-4369-8274-e1f1dc479c1c' }) },
		emitEvent: async () => {},
		drainPending: async function* () {},
		resumeHandler: async (request: HITLDecisionRequest) => {
			seen.push(request)
			return handler(request)
		},
		verificationGate: new AuthorizationGate(opts.gate ?? ALLOW_BASH, log),
		...(opts.grants ? { toolGrants: opts.grants } : {}),
		...(opts.reviewAllowedCalls ? { reviewAllowedCalls: opts.reviewAllowedCalls } : {}),
	} as unknown as IterationContext
	return { ctx, executed, messages, seen }
}

async function run(ctx: IterationContext, resp: ChatCompletionResponse) {
	const gen = runToolReview(ctx, resp, 1)
	let next = await gen.next()
	while (!next.done) next = await gen.next()
	return next.value.decision
}

const planHandler = createReviewHandler({ mode: 'plan', exempt: () => false })

describe('runToolReview — reviewAllowedCalls', () => {
	it('without it, a batch a rule allows runs and the handler is never asked', async () => {
		const h = harness({ handler: planHandler })
		expect(await run(h.ctx, bashResponse())).toBe('executed')
		expect(h.seen).toEqual([])
		expect(h.executed).toEqual(['bash'])
	})

	it('returning false keeps the shortcut', async () => {
		const h = harness({ handler: planHandler, reviewAllowedCalls: () => false })
		expect(await run(h.ctx, bashResponse())).toBe('executed')
		expect(h.seen).toEqual([])
		expect(h.executed).toEqual(['bash'])
	})

	it('returning true sends an allowed batch to the handler, and plan mode refuses it', async () => {
		const h = harness({ handler: planHandler, reviewAllowedCalls: () => true })
		expect(await run(h.ctx, bashResponse())).toBe('rejected')
		expect(h.executed).toEqual([])
		expect(h.seen).toHaveLength(1)
		const request = h.seen[0]
		expect(request?.type).toBe('tool_review')
		if (request?.type === 'tool_review') {
			// The handler sees what the rule decided.
			expect(request.toolCalls[0]?.authorization?.decision).toBe('allow')
		}
		expect(h.messages.some((m) => String(m.content).includes(PLAN_MODE_REFUSAL))).toBe(true)
	})

	it('an approving handler still runs the allowed batch', async () => {
		const h = harness({ reviewAllowedCalls: () => true })
		expect(await run(h.ctx, bashResponse())).toBe('executed')
		expect(h.seen).toHaveLength(1)
		expect(h.executed).toEqual(['bash'])
	})

	it('a grant from earlier in the turn does not let a batch past a handler that wants it', async () => {
		const grants = new ToolGrantSet()
		grants.grant(['bash'])
		// No gate rule for bash: without the grant this would be a review anyway.
		const gate = gateConfig({ rules: [] })
		const skipped = harness({ gate, grants, handler: planHandler })
		expect(await run(skipped.ctx, bashResponse())).toBe('executed')
		expect(skipped.seen, 'the grant shortcut, as before').toEqual([])

		const asked = harness({ gate, grants, handler: planHandler, reviewAllowedCalls: () => true })
		expect(await run(asked.ctx, bashResponse())).toBe('rejected')
		expect(asked.executed).toEqual([])
	})

	it('is read once per batch', async () => {
		const reviewAllowedCalls = vi.fn(() => true)
		const grants = new ToolGrantSet()
		grants.grant(['bash'])
		const h = harness({ grants, reviewAllowedCalls })
		await run(h.ctx, bashResponse())
		expect(reviewAllowedCalls).toHaveBeenCalledTimes(1)
	})

	it('a rule deny still refuses whatever the handler answers', async () => {
		const h = harness({
			gate: gateConfig({ rules: [{ type: 'deny_by_name', toolNames: ['bash'] }] }),
			reviewAllowedCalls: () => true,
		})
		expect(await run(h.ctx, bashResponse())).toBe('rejected')
		expect(h.executed).toEqual([])
		expect(h.seen).toEqual([])
	})
})
