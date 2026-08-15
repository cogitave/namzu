import { describe, expect, it, vi } from 'vitest'

import { findDanglingMessages } from '../../../../compaction/dangling.js'
import { ActivityStore } from '../../../../store/activity/memory.js'
import type { HITLResumeDecision } from '../../../../types/hitl/index.js'
import type { RunId } from '../../../../types/ids/index.js'
import type { Message } from '../../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../../types/provider/index.js'
import type { ToolRegistryContract } from '../../../../types/tool/index.js'
import type { VerificationGateConfig } from '../../../../types/verification/index.js'
import type { Logger } from '../../../../utils/logger.js'
import { VerificationGate } from '../../../../verification/gate.js'
import { ToolExecutor } from '../../executor.js'
import type { IterationContext } from './context.js'
import { runToolReview } from './tool-review.js'

/**
 * Regression suite for the tool-review invariant:
 *
 *   Every `tool_use` block the model emits is answered by exactly one
 *   `tool_result`, on every path — gate denial, human rejection, partial
 *   approval — because an unanswered `tool_use` makes the NEXT provider
 *   request malformed and kills the run.
 *
 * Plus the policy invariant discovered alongside it: a human "approve" on
 * the gate's mixed-decision path must not execute the calls the gate
 * denied.
 *
 * Plus, since LOG-14: a gate denial is a first-class 'refused' AuditEvent,
 * never an absent record.
 */

const RUN_ID = 'run_denial_test' as RunId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

/** `read` is read-only (gate-allowable); `bash rm -rf /` trips deny_dangerous_patterns. */
function response(): ChatCompletionResponse {
	return {
		id: 'resp_1',
		model: 'test',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'call_safe',
					type: 'function',
					function: { name: 'read', arguments: JSON.stringify({ path: 'a.txt' }) },
				},
				{
					id: 'call_danger',
					type: 'function',
					function: { name: 'bash', arguments: JSON.stringify({ command: 'rm -rf /' }) },
				},
			],
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

/** Only the `read` call, for a scenario the gate all-allows. */
function readOnlyResponse(): ChatCompletionResponse {
	const resp = response()
	return {
		...resp,
		message: {
			...resp.message,
			toolCalls: resp.message.toolCalls?.filter((tc) => tc.function.name === 'read'),
		},
	}
}

interface Harness {
	ctx: IterationContext
	messages: Message[]
	executed: string[]
	recordAudit: ReturnType<typeof vi.fn>
}

/** The schema fills defaults; tests only state the rules they care about. */
function gateConfig(partial: Partial<VerificationGateConfig>): VerificationGateConfig {
	return {
		enabled: true,
		rules: [],
		allowReadOnlyTools: false,
		denyDangerousPatterns: false,
		logDecisions: false,
		...partial,
	}
}

function harness(opts: {
	gate?: VerificationGateConfig
	decision?: HITLResumeDecision
}): Harness {
	const executed: string[] = []
	const messages: Message[] = []
	const log = makeLogger()
	const recordAudit = vi.fn(async () => undefined as never)

	const toolDefs: Record<string, { readOnly: boolean; category: string }> = {
		read: { readOnly: true, category: 'filesystem' },
		bash: { readOnly: false, category: 'shell' },
	}

	const tools = {
		get: vi.fn((name: string) => {
			const def = toolDefs[name]
			if (!def) return undefined
			return {
				name,
				category: def.category,
				isReadOnly: () => def.readOnly,
				isDestructive: () => !def.readOnly,
				isConcurrencySafe: () => def.readOnly,
			}
		}),
		execute: vi.fn(async (name: string) => {
			executed.push(name)
			return { success: true, output: `${name} ok` }
		}),
		has: vi.fn(() => true),
		listNames: vi.fn(() => Object.keys(toolDefs)),
		getAvailability: vi.fn(() => 'active'),
		register: vi.fn(),
		unregister: vi.fn(),
	} as unknown as ToolRegistryContract

	const toolExecutor = new ToolExecutor(
		{
			tools,
			runId: RUN_ID,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
		},
		new ActivityStore(RUN_ID, { enabled: true, trackToolCalls: true, trackLlmTurns: true }),
		async () => {},
		log,
	)

	const ctx = {
		tools,
		toolExecutor,
		log,
		abortController: new AbortController(),
		runMgr: {
			id: RUN_ID,
			messages,
			pushMessage: (m: Message) => {
				messages.push(m)
			},
			setStopReason: vi.fn(),
			markCancelled: vi.fn(),
			recordAudit,
		},
		checkpointMgr: { create: async () => ({ id: 'cp_1' }) },
		emitEvent: async () => {},
		drainPending: async function* () {},
		resumeHandler: async () => opts.decision ?? ({ action: 'approve_tools' } as HITLResumeDecision),
		verificationGate: opts.gate ? new VerificationGate(opts.gate, log) : undefined,
	} as unknown as IterationContext

	return { ctx, messages, executed, recordAudit }
}

/** Drain the generator and return its decision. */
async function run(ctx: IterationContext, resp: ChatCompletionResponse) {
	const gen = runToolReview(ctx, resp, 1)
	let next = await gen.next()
	while (!next.done) next = await gen.next()
	return next.value.decision
}

/** The whole point: history must be sendable to a provider afterwards. */
function expectEveryToolCallAnswered(messages: Message[], resp: ChatCompletionResponse) {
	const assistant: Message = {
		role: 'assistant',
		content: resp.message.content,
		toolCalls: resp.message.toolCalls,
	}
	const history = [assistant, ...messages]
	const dangling = findDanglingMessages(history)
	expect(dangling.assistantsWithUnmatchedCalls).toEqual([])
	expect(dangling.orphanedToolMessages).toEqual([])
	expect(dangling.isValid).toBe(true)

	const answered = messages
		.filter((m): m is Message & { toolCallId: string } => m.role === 'tool')
		.map((m) => m.toolCallId)
	expect(answered.sort()).toEqual((resp.message.toolCalls ?? []).map((tc) => tc.id).sort())
}

describe('runToolReview — every tool_use is answered', () => {
	it('gate all-deny still emits a tool_result per call', async () => {
		const h = harness({
			gate: gateConfig({ rules: [{ type: 'deny_by_name', toolNames: ['read', 'bash'] }] }),
		})
		const resp = response()
		const outcome = await run(h.ctx, resp)

		expect(outcome).toBe('rejected')
		expect(h.executed).toEqual([])
		expectEveryToolCallAnswered(h.messages, resp)
		// The reason must travel inside the tool_result so it can steer.
		expect(h.messages.some((m) => String(m.content).includes('verification gate'))).toBe(true)
	})

	it('human reject_tools still emits a tool_result per call, carrying the feedback', async () => {
		const h = harness({
			decision: { action: 'reject_tools', feedback: 'Use the API instead of shelling out.' },
		})
		const resp = response()
		const outcome = await run(h.ctx, resp)

		expect(outcome).toBe('rejected')
		expect(h.executed).toEqual([])
		expectEveryToolCallAnswered(h.messages, resp)
		expect(h.messages.some((m) => String(m.content).includes('Use the API instead'))).toBe(true)
	})

	it('modify_tools with a PARTIAL deny answers the denied call too', async () => {
		const h = harness({
			decision: {
				action: 'modify_tools',
				modifications: [{ toolCallId: 'call_danger', action: 'deny' }],
			} as HITLResumeDecision,
		})
		const resp = response()
		const outcome = await run(h.ctx, resp)

		expect(outcome).toBe('executed')
		expect(h.executed).toEqual(['read'])
		expectEveryToolCallAnswered(h.messages, resp)
	})

	it('plain approval executes everything and answers everything', async () => {
		const h = harness({ decision: { action: 'approve_tools' } })
		const resp = response()
		const outcome = await run(h.ctx, resp)

		expect(outcome).toBe('executed')
		expect(h.executed.sort()).toEqual(['bash', 'read'])
		expectEveryToolCallAnswered(h.messages, resp)
	})
})

describe('runToolReview — a gate denial outranks a human approval', () => {
	it('approve_tools on the gate MIXED path does not execute the gate-denied call', async () => {
		// allow_read_only allows `read`; deny_dangerous_patterns denies the
		// `rm -rf /` bash call → mixed → human review → human approves.
		const h = harness({
			gate: gateConfig({ allowReadOnlyTools: true, denyDangerousPatterns: true }),
			decision: { action: 'approve_tools' },
		})
		const resp = response()
		const outcome = await run(h.ctx, resp)

		expect(outcome).toBe('executed')
		// THE BUG: this used to be ['read', 'bash'] — approval replayed the
		// full unfiltered response and ran the call the gate refused.
		expect(h.executed).toEqual(['read'])
		expectEveryToolCallAnswered(h.messages, resp)
	})

	it('modify_tools cannot rewrite a gate-denied call back into execution', async () => {
		const h = harness({
			gate: gateConfig({ allowReadOnlyTools: true, denyDangerousPatterns: true }),
			decision: {
				action: 'modify_tools',
				modifications: [
					{ toolCallId: 'call_danger', action: 'modify', modifiedInput: { command: 'ls' } },
				],
			} as HITLResumeDecision,
		})
		const resp = response()
		await run(h.ctx, resp)

		expect(h.executed).toEqual(['read'])
		expectEveryToolCallAnswered(h.messages, resp)
	})
})

describe('runToolReview — a gate denial is a first-class audit event (LOG-14)', () => {
	it('records one refused AuditEvent per gate-denied tool call', async () => {
		const h = harness({
			gate: gateConfig({ rules: [{ type: 'deny_by_name', toolNames: ['read', 'bash'] }] }),
		})
		const resp = response()
		await run(h.ctx, resp)

		expect(h.recordAudit).toHaveBeenCalledTimes(2)
		expect(h.recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				what: expect.objectContaining({ action: 'tool_call', tool: 'read' }),
				outcome: 'refused',
			}),
		)
		expect(h.recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				what: expect.objectContaining({ action: 'tool_call', tool: 'bash' }),
				outcome: 'refused',
			}),
		)
	})

	it('a call the gate ALLOWS is never audited as refused', async () => {
		const h = harness({ gate: gateConfig({ allowReadOnlyTools: true }) })
		await run(h.ctx, readOnlyResponse())

		expect(h.recordAudit).not.toHaveBeenCalled()
	})
})
