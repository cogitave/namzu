import { describe, expect, it, vi } from 'vitest'

import { AuthorizationGate } from '../../../../authorization/gate.js'
import { ActivityStore } from '../../../../store/activity/memory.js'
import type { ToolManager } from '../../../../toolsets/manager.js'
import type { AuthorizationGateConfig } from '../../../../types/authorization/index.js'
import type { HITLDecisionRequest, HITLResumeDecision } from '../../../../types/hitl/index.js'
import type { TurnId } from '../../../../types/ids/index.js'
import type { Message } from '../../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../../types/provider/index.js'
import type { ToolDefinition } from '../../../../types/tool/index.js'
import { generateSessionId } from '../../../../utils/id.js'
import type { Logger } from '../../../../utils/logger.js'
import { ToolExecutor } from '../../executor.js'
import {
	type ReviewMode,
	type ScreenConsentRecord,
	type ToolReviewPrompt,
	createReviewHandler,
} from '../../review-policy.js'
import type { IterationContext } from './context.js'
import { runToolReview } from './tool-review.js'

/**
 * The first screenshot of a session reaches the person, although every rule
 * that allows reads would let it run: the read-only rule steps aside for a
 * call that captures the screen, and the review policy asks once.
 *
 * The defect this pins: with the consent record in the policy alone, a real
 * session took two screenshots unasked — the gate's `allow_read_only` let
 * them through before any handler was consulted — and the box first opened
 * over a click.
 */

const SESSION_ID = generateSessionId()
const TURN_ID = '0b2c3a8e-5d1f-4f7e-9a61-3c0e8b6d2f11' as TurnId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
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

function response(name: string, input: unknown, id = 'call_1'): ChatCompletionResponse {
	return {
		id: 'resp_1',
		model: 'test',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }],
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

const computerUse = {
	name: 'computer_use',
	category: 'custom',
	isReadOnly: (input: unknown) => (input as { type?: string })?.type === 'screenshot',
	isDestructive: () => false,
	isConcurrencySafe: () => false,
	capturesScreen: (input: unknown) => (input as { type?: string })?.type !== 'cursor_position',
} as unknown as ToolDefinition

const read = {
	name: 'read',
	category: 'filesystem',
	isReadOnly: () => true,
	isDestructive: () => false,
	isConcurrencySafe: () => true,
} as unknown as ToolDefinition

function harness(opts: {
	mode?: ReviewMode
	answer?: 'approve' | 'reject'
	gate?: AuthorizationGateConfig
}) {
	const executed: string[] = []
	const messages: Message[] = []
	const seen: HITLDecisionRequest[] = []
	const log = makeLogger()
	const byName: Record<string, ToolDefinition> = { computer_use: computerUse, read }
	const tools = {
		get: vi.fn((name: string) => byName[name]),
		execute: vi.fn(async (name: string) => {
			executed.push(name)
			return { success: true, output: `${name} ok` }
		}),
		has: vi.fn(() => true),
		sourceOf: vi.fn(() => ({ id: 'host', kind: 'host_tool' as const })),
		listNames: vi.fn(() => Object.keys(byName)),
		availability: vi.fn(() => 'active'),
	} as unknown as ToolManager
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
	const prompt = vi.fn<ToolReviewPrompt>(async () =>
		opts.answer === 'reject' ? { kind: 'reject' } : { kind: 'approve' },
	)
	const consent: ScreenConsentRecord = { sessions: new Set() }
	const handler = createReviewHandler({
		mode: opts.mode ?? 'prompt',
		prompt,
		registry: tools,
		screenConsent: consent,
	})
	const ctx = {
		tools,
		toolExecutor,
		log,
		abortController: new AbortController(),
		recorder: {
			id: TURN_ID,
			sessionId: SESSION_ID,
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
		resumeHandler: async (request: HITLDecisionRequest): Promise<HITLResumeDecision> => {
			seen.push(request)
			return handler(request)
		},
		verificationGate: new AuthorizationGate(opts.gate ?? gateConfig({}), log),
	} as unknown as IterationContext
	return { ctx, executed, seen, prompt, consent }
}

async function run(ctx: IterationContext, resp: ChatCompletionResponse) {
	const gen = runToolReview(ctx, resp, 1)
	let next = await gen.next()
	while (!next.done) next = await gen.next()
	return next.value.decision
}

describe('runToolReview — the first screenshot of a session', () => {
	it('is put to the person although reads are allowed, and later ones run unasked', async () => {
		const h = harness({})
		expect(await run(h.ctx, response('computer_use', { type: 'screenshot' }))).toBe('executed')
		expect(h.prompt).toHaveBeenCalledTimes(1)
		expect(h.prompt.mock.calls[0]?.[0].screenConsent).toBe(true)
		expect(await run(h.ctx, response('computer_use', { type: 'screenshot' }, 'call_2'))).toBe(
			'executed',
		)
		expect(h.prompt).toHaveBeenCalledTimes(1)
		expect(h.executed).toEqual(['computer_use', 'computer_use'])
	})

	it('leaves an ordinary read to the read-only rule, and a declined look runs nothing', async () => {
		const h = harness({ answer: 'reject' })
		expect(await run(h.ctx, response('read', { path: 'a' }))).toBe('executed')
		expect(h.seen).toEqual([])
		expect(await run(h.ctx, response('computer_use', { type: 'screenshot' }, 'call_2'))).toBe(
			'rejected',
		)
		expect(h.executed).toEqual(['read'])
		expect(h.consent.sessions.size).toBe(0)
	})

	it('runs without asking when a rule allows the tool by name', async () => {
		const h = harness({
			gate: gateConfig({ rules: [{ type: 'allow_by_name', toolNames: ['computer_use'] }] }),
		})
		expect(await run(h.ctx, response('computer_use', { type: 'screenshot' }))).toBe('executed')
		expect(h.prompt).not.toHaveBeenCalled()
		expect(h.seen).toEqual([])
	})
})
