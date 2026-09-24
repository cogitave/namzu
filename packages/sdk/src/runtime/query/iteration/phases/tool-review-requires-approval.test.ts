import { describe, expect, it, vi } from 'vitest'

import { AuthorizationGate } from '../../../../authorization/gate.js'
import { SkillGrantSet } from '../../../../authorization/skill-grant.js'
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
import { type ToolReviewPrompt, createReviewHandler } from '../../review-policy.js'
import { ToolGrantSet } from '../../tool-grants.js'
import type { IterationContext } from './context.js'
import { runToolReview } from './tool-review.js'

/**
 * `ToolDefinition.requiresApproval`, end to end through `runToolReview` and
 * the two call sites the gap named:
 *
 * 1. tool-review.ts's `allow`-rule override, extended for this flag the way
 *    it already existed for `escalation` — otherwise a batch the gate fully
 *    allows never reaches review at all (`allAllowed` at tool-review.ts).
 * 2. Nothing recorded during review — a skill's `allowed-tools`, a
 *    remembered `ToolGrantSet` entry — may stand in for the person it names.
 *
 * `an-escape-is-asked-about-every-time.test.ts` and
 * `a-tool-declared-approval-is-asked-about-every-time.test.ts` cover the
 * review-policy half (every mode) directly, without a turn.
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

/** `pay` always needs a person's approval, whatever the operator's rules say. */
const DEFINITIONS: Record<string, ToolDefinition> = {
	pay: fakeTool('pay', { requiresApproval: () => true }),
	notify: fakeTool('notify'),
}

const gateConfig = (partial: Partial<AuthorizationGateConfig> = {}): AuthorizationGateConfig => ({
	enabled: true,
	rules: [],
	allowReadOnlyTools: false,
	denyDangerousPatterns: false,
	logDecisions: false,
	...partial,
})

interface Turn {
	ctx: IterationContext
	executed: string[]
	messages: Message[]
	audits: unknown[]
	events: { type: string; toolCalls?: readonly { name: string; skillGrant?: unknown }[] }[]
}

function turn(opts: {
	gate?: AuthorizationGateConfig
	resumeHandler: (request: HITLDecisionRequest) => Promise<HITLResumeDecision>
	skillGrants?: SkillGrantSet
	toolGrants?: ToolGrantSet
}): Turn {
	const executed: string[] = []
	const messages: Message[] = []
	const audits: unknown[] = []
	const events: Turn['events'] = []
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
			recordAudit: vi.fn(async (entry: unknown) => {
				audits.push(entry)
			}),
		},
		checkpointMgr: { create: async () => ({ id: 'f1e2d3c4-5b6a-4978-8899-aabbccddeeff' }) },
		emitEvent: async (event: Turn['events'][number]) => {
			events.push(event)
		},
		drainPending: async function* () {},
		resumeHandler: opts.resumeHandler,
		verificationGate: new AuthorizationGate(opts.gate ?? gateConfig(), log),
		...(opts.skillGrants ? { skillGrants: opts.skillGrants } : {}),
		...(opts.toolGrants ? { toolGrants: opts.toolGrants } : {}),
	} as unknown as IterationContext

	return { ctx, executed, messages, audits, events }
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

async function run(t: Turn, resp: ChatCompletionResponse) {
	const gen = runToolReview(t.ctx, resp, 1)
	let next = await gen.next()
	while (!next.done) next = await gen.next()
	return next.value.decision
}

describe('an `allow` rule cannot let a requiresApproval call skip review', () => {
	it('is still asked about, and only executes after approval', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const handler = createReviewHandler({
			mode: 'prompt',
			prompt,
			registry: {
				get: (name: string) => DEFINITIONS[name],
				sourceOf: () => ({ id: 'test', kind: 'host_tool' as const }),
			},
		})
		const t = turn({
			gate: gateConfig({ rules: [{ type: 'allow_by_name', toolNames: ['pay'] }] }),
			resumeHandler: handler,
		})

		const outcome = await run(t, response('pay', { amountCents: 500 }))

		expect(outcome).toBe('executed')
		expect(t.executed).toEqual(['pay'])
		// The whole point: an all-`allow` gate result used to settle the batch
		// immediately, before the handler — and so `prompt` — ever ran.
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('a deny rule still refuses it, even though the tool demands approval', async () => {
		const resumeHandler = vi.fn(async () => ({ action: 'approve_tools' }) as HITLResumeDecision)
		const t = turn({
			gate: gateConfig({ rules: [{ type: 'deny_by_name', toolNames: ['pay'] }] }),
			resumeHandler,
		})

		const outcome = await run(t, response('pay', { amountCents: 500 }))

		expect(outcome).toBe('rejected')
		expect(t.executed).toEqual([])
		// A gate denial settles the batch on its own; a person is never asked.
		expect(resumeHandler).not.toHaveBeenCalled()
		expect(t.messages.some((m) => String(m.content).includes('authorization gate'))).toBe(true)
	})
})

describe('nothing recorded earlier in the turn stands in for the person requiresApproval names', () => {
	it("a skill's allowed-tools does not pre-approve it", async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const handler = createReviewHandler({
			mode: 'prompt',
			prompt,
			registry: {
				get: (name: string) => DEFINITIONS[name],
				sourceOf: () => ({ id: 'test', kind: 'host_tool' as const }),
			},
		})
		const grants = new SkillGrantSet()
		grants.grant('money-skill', { entries: [{ tool: 'pay', declared: 'pay' }], ignored: [] })
		const t = turn({ resumeHandler: handler, skillGrants: grants })

		const outcome = await run(t, response('pay', { amountCents: 500 }))

		expect(outcome).toBe('executed')
		expect(prompt).toHaveBeenCalledTimes(1)
		// Never marked as skill-granted, so the audit trail cannot claim
		// nobody was asked when somebody was.
		expect(t.audits).not.toContainEqual(
			expect.objectContaining({ reason: expect.stringContaining('pre-approved') }),
		)
		// Defense in depth, independent of the review policy: the kernel
		// itself never marks this call skill-granted in the first place.
		const requested = t.events.find((e) => e.type === 'tool_review_requested')
		expect(requested?.toolCalls?.find((tc) => tc.name === 'pay')?.skillGrant).toBeUndefined()
	})

	it('an already-recorded tool grant does not cover it either', async () => {
		const resumeHandler = vi.fn(async () => ({ action: 'approve_tools' }) as HITLResumeDecision)
		const toolGrants = new ToolGrantSet()
		toolGrants.grant(['pay'])
		const t = turn({ resumeHandler, toolGrants })

		const outcome = await run(t, response('pay', { amountCents: 500 }))

		expect(outcome).toBe('executed')
		// The grant-covers shortcut settles the batch without ever calling the
		// handler; reaching it at all is the assertion.
		expect(resumeHandler).toHaveBeenCalledTimes(1)
	})
})
