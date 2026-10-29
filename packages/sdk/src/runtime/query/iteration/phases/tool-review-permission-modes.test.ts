import { describe, expect, it, vi } from 'vitest'

import { AuthorizationGate, allowRuleScope } from '../../../../authorization/gate.js'
import { ActivityStore } from '../../../../store/activity/memory.js'
import type { ToolManager } from '../../../../toolsets/manager.js'
import type {
	AuthorizationGateConfig,
	AuthorizationRule,
} from '../../../../types/authorization/index.js'
import type {
	HITLDecisionRequest,
	HITLResumeDecision,
	ResumeContext,
	ToolCallSummary,
} from '../../../../types/hitl/index.js'
import type { TurnId } from '../../../../types/ids/index.js'
import type { Message } from '../../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../../types/provider/index.js'
import type { ToolDefinition } from '../../../../types/tool/index.js'
import { generateSessionId } from '../../../../utils/id.js'
import type { Logger } from '../../../../utils/logger.js'
import { ToolExecutor } from '../../executor.js'
import { UNFINISHED_CHECK_UNATTENDED_REFUSAL, createReviewHandler } from '../../review-policy.js'
import { ToolGrantSet } from '../../tool-grants.js'
import type { IterationContext } from './context.js'
import { runToolReview } from './tool-review.js'

/**
 * What the review phase tells a policy about a call, for the two modes that
 * keep only some questions for a person: which rule asked (as opposed to an
 * allow that was demoted), how wide an allow rule is, the conversation the
 * handler is offered, and a call whose safety checks threw.
 */

const SESSION_ID = generateSessionId()
const TURN_ID = 'b7e0c1a2-3d4e-4f5a-9b6c-7d8e9f0a1b2c' as TurnId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function fakeTool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name,
		category: 'custom',
		isReadOnly: () => false,
		isDestructive: () => false,
		isConcurrencySafe: () => false,
		...extra,
	} as unknown as ToolDefinition
}

const DEFINITIONS: Record<string, ToolDefinition> = {
	notify: fakeTool('notify'),
	pay: fakeTool('pay', { requiresApproval: () => true }),
	// Its own path check throws, as a bug in a tool's `isReadOnly` would.
	flaky: fakeTool('flaky', {
		pathArgument: 'path',
		isReadOnly: () => {
			throw new Error('the read-only check blew up')
		},
	}),
}

const gateConfig = (partial: Partial<AuthorizationGateConfig> = {}): AuthorizationGateConfig => ({
	enabled: true,
	rules: [],
	allowReadOnlyTools: false,
	denyDangerousPatterns: false,
	logDecisions: false,
	...partial,
})

function turn(opts: {
	gate?: AuthorizationGateConfig
	resumeHandler: (
		request: HITLDecisionRequest,
		context?: ResumeContext,
	) => Promise<HITLResumeDecision>
	reviewAllowedCalls?: () => boolean
	toolGrants?: ToolGrantSet
}) {
	const executed: string[] = []
	const messages: Message[] = [{ role: 'user', content: 'do the thing' } as Message]
	const events: { type: string; toolCalls?: readonly ToolCallSummary[] }[] = []
	const log = makeLogger()
	const tools = {
		get: vi.fn((name: string) => DEFINITIONS[name]),
		execute: vi.fn(async (name: string) => {
			executed.push(name)
			return { success: true, output: `${name} ok` }
		}),
		has: vi.fn((name: string) => name in DEFINITIONS),
		sourceOf: vi.fn(() => ({ id: 'host', kind: 'host_tool' as const })),
		listNames: vi.fn(() => Object.keys(DEFINITIONS)),
		availability: vi.fn(() => 'active'),
	} as unknown as ToolManager
	const controller = new AbortController()
	const toolExecutor = new ToolExecutor(
		{
			sessionId: SESSION_ID,
			tools,
			turnId: TURN_ID,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			outsideRootAccess: 'review',
			env: {},
			abortSignal: controller.signal,
		},
		new ActivityStore(TURN_ID, { enabled: true, trackToolCalls: true, trackLlmTurns: true }),
		async () => {},
		log,
	)
	const ctx = {
		tools,
		toolExecutor,
		log,
		abortController: controller,
		recorder: {
			id: TURN_ID,
			messages,
			pushMessage: (m: Message) => {
				messages.push(m)
			},
			setStopReason: vi.fn(),
			markCancelled: vi.fn(),
			recordAudit: vi.fn(async () => {}),
		},
		checkpointMgr: { create: async () => ({ id: 'f1e2d3c4-5b6a-4978-8899-aabbccddeeff' }) },
		emitEvent: async (event: (typeof events)[number]) => {
			events.push(event)
		},
		drainPending: async function* () {},
		resumeHandler: opts.resumeHandler,
		verificationGate: new AuthorizationGate(opts.gate ?? gateConfig(), log),
		...(opts.reviewAllowedCalls ? { reviewAllowedCalls: opts.reviewAllowedCalls } : {}),
		...(opts.toolGrants ? { toolGrants: opts.toolGrants } : {}),
	} as unknown as IterationContext
	return { ctx, executed, messages, events, controller }
}

function response(name: string, input: unknown): ChatCompletionResponse {
	return {
		id: 'resp_1',
		model: 'test',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(input) } },
			],
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

async function run(t: ReturnType<typeof turn>, resp: ChatCompletionResponse) {
	const gen = runToolReview(t.ctx, resp, 1)
	let next = await gen.next()
	while (!next.done) next = await gen.next()
	return next.value.decision
}

/** The summaries the handler was shown. */
function capture() {
	const seen: ToolCallSummary[] = []
	const contexts: (ResumeContext | undefined)[] = []
	const resumeHandler = vi.fn(async (request: HITLDecisionRequest, context?: ResumeContext) => {
		if (request.type === 'tool_review') seen.push(...request.toolCalls)
		contexts.push(context)
		return { action: 'approve_tools' } as HITLResumeDecision
	})
	return { seen, contexts, resumeHandler }
}

describe('which rule asked', () => {
	it('marks a call a review rule asked about', async () => {
		const c = capture()
		const t = turn({
			resumeHandler: c.resumeHandler,
			gate: gateConfig({
				rules: [
					{
						type: 'argument_pattern',
						toolNames: ['notify'],
						argument: 'to',
						pattern: '.*',
						decision: 'review',
					},
				],
			}),
		})
		await run(t, response('notify', { to: 'x' }))
		expect(c.seen[0]?.authorization).toMatchObject({ explicitReview: true, askRule: true })
	})

	it('does not mark an allow that was demoted to a question', async () => {
		const c = capture()
		const t = turn({
			resumeHandler: c.resumeHandler,
			gate: gateConfig({ rules: [{ type: 'allow_by_name', toolNames: ['pay'] }] }),
		})
		await run(t, response('pay', { amountCents: 5 }))
		expect(c.seen[0]?.authorization?.explicitReview).toBeUndefined()
		expect(c.seen[0]?.authorization?.askRule).toBeUndefined()
	})

	it('does not mark a call no rule covered', async () => {
		const c = capture()
		const t = turn({ resumeHandler: c.resumeHandler })
		await run(t, response('notify', {}))
		expect(c.seen[0]?.authorization).toEqual({
			decision: 'review',
			reason: 'No matching rule found',
		})
	})
})

describe('a hook that asked for a person', () => {
	it('is an ask the modes cannot waive, with or without an operator gate', async () => {
		const c = capture()
		const t = turn({ resumeHandler: c.resumeHandler })
		// No gate configured: the summary comes from the prepared batch alone.
		;(t.ctx as { verificationGate?: unknown }).verificationGate = undefined
		const real = t.ctx.toolExecutor.prepareBatchForReview.bind(t.ctx.toolExecutor)
		t.ctx.toolExecutor.prepareBatchForReview = async (...args) => {
			const prepared = await real(...args)
			for (const call of prepared.reviewCalls) {
				;(call as { hookPermission?: unknown }).hookPermission = {
					decision: 'ask',
					reason: 'ask first',
				}
			}
			return prepared
		}
		await run(t, response('notify', {}))
		expect(c.seen[0]?.authorization).toMatchObject({ explicitReview: true, askRule: true })
	})
})

describe('a remembered grant', () => {
	const askRule: AuthorizationRule = {
		type: 'argument_pattern',
		toolNames: ['notify'],
		argument: 'to',
		pattern: '.*',
		decision: 'review',
	}

	it('does not stand in for an ask rule', async () => {
		const c = capture()
		const grants = new ToolGrantSet()
		grants.grant(['notify'])
		const t = turn({
			resumeHandler: c.resumeHandler,
			gate: gateConfig({ rules: [askRule] }),
			toolGrants: grants,
		})
		await run(t, response('notify', { to: 'x' }))
		expect(c.resumeHandler).toHaveBeenCalledTimes(1)
	})

	it('still covers a call nothing asked about', async () => {
		const c = capture()
		const grants = new ToolGrantSet()
		grants.grant(['notify'])
		const t = turn({ resumeHandler: c.resumeHandler, toolGrants: grants })
		await run(t, response('notify', { to: 'x' }))
		expect(c.resumeHandler).not.toHaveBeenCalled()
		expect(t.executed).toEqual(['notify'])
	})
})

describe('how wide an allow rule is', () => {
	it('says so on a call an allow rule settled, when the policy asked to see it', async () => {
		const c = capture()
		const t = turn({
			resumeHandler: c.resumeHandler,
			reviewAllowedCalls: () => true,
			gate: gateConfig({ rules: [{ type: 'allow_by_name', toolNames: ['notify'] }] }),
		})
		await run(t, response('notify', {}))
		expect(c.seen[0]?.authorization).toMatchObject({ decision: 'allow', allowScope: 'tool' })
	})

	it('reads a rule as whole-tool or as a pattern', () => {
		expect(allowRuleScope(null)).toBeUndefined()
		expect(allowRuleScope({ type: 'allow_by_name', toolNames: ['bash'] })).toBe('tool')
		expect(allowRuleScope({ type: 'allow_by_category', categories: ['shell'] })).toBe('tool')
		expect(allowRuleScope({ type: 'allow_by_tier', tiers: ['a'] })).toBe('tool')
		expect(allowRuleScope({ type: 'by_source', sources: ['x'], decision: 'allow' })).toBe('tool')
		expect(
			allowRuleScope({ type: 'by_source', sources: ['x'], decision: 'review' }),
		).toBeUndefined()
		expect(allowRuleScope({ type: 'deny_by_name', toolNames: ['bash'] })).toBeUndefined()
		expect(allowRuleScope({ type: 'allow_read_only' })).toBeUndefined()
		const argument = (
			pattern: string,
			decision: 'allow' | 'deny' = 'allow',
		): AuthorizationRule => ({
			type: 'argument_pattern',
			toolNames: ['bash'],
			argument: 'command',
			pattern,
			decision,
		})
		expect(allowRuleScope(argument('^git status'))).toBe('pattern')
		for (const wide of ['', '*', '.*', '^.*$']) expect(allowRuleScope(argument(wide))).toBe('tool')
		expect(allowRuleScope(argument('.*', 'deny'))).toBeUndefined()
		expect(
			allowRuleScope({ type: 'custom_pattern', pattern: '^ls', target: 'args', decision: 'allow' }),
		).toBe('pattern')
		expect(
			allowRuleScope({
				type: 'predicate',
				description: 'd',
				decide: () => 'allow',
			} as never),
		).toBe('pattern')
	})
})

describe('what a handler is offered besides the request', () => {
	it("is the conversation as it stands and the turn's signal, never copied into the request", async () => {
		const c = capture()
		const t = turn({ resumeHandler: c.resumeHandler })
		await run(t, response('notify', {}))
		const [context] = c.contexts
		expect(context?.transcript()).toBe(t.messages)
		expect(context?.signal).toBe(t.controller.signal)
		expect(JSON.stringify(c.seen)).not.toContain('do the thing')
	})
})

describe('a call whose safety checks threw', () => {
	it('is a question of its own rather than being read as clean', async () => {
		const c = capture()
		const t = turn({ resumeHandler: c.resumeHandler })
		await run(t, response('flaky', { path: 'a.txt' }))
		const reported = c.seen[0]?.escalation?.unfinishedCheck
		// A fixed sentence and a code, not the error's own words.
		expect(reported).toBe('the safety checks did not finish (Error)')
		expect(reported).not.toContain('blew up')
	})

	it('is refused by every mode when nobody can be asked, and asked about when somebody can', async () => {
		for (const mode of ['prompt', 'auto', 'bypass'] as const) {
			const refusing = turn({
				resumeHandler: createReviewHandler({
					mode,
					registry: {
						get: (n) => DEFINITIONS[n],
						sourceOf: () => ({ id: 't', kind: 'host_tool' as const }),
					},
				}),
			})
			const outcome = await run(refusing, response('flaky', { path: 'a.txt' }))
			expect(outcome, mode).toBe('rejected')
			expect(refusing.executed, mode).toEqual([])
			expect(
				refusing.messages.some((m) =>
					String(m.content).includes(UNFINISHED_CHECK_UNATTENDED_REFUSAL),
				),
				mode,
			).toBe(true)
			const prompt = vi.fn(async () => ({ kind: 'approve' as const }))
			const asking = turn({
				resumeHandler: createReviewHandler({ mode, prompt }),
			})
			await run(asking, response('flaky', { path: 'a.txt' }))
			expect(prompt, mode).toHaveBeenCalledTimes(1)
		}
	})
})
