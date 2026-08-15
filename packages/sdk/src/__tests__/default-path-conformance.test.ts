import { describe, expect, it, vi } from 'vitest'

import { findDanglingMessages } from '../compaction/dangling.js'
import { MockLLMProvider } from '../provider/mock.js'
import { ToolExecutor } from '../runtime/query/executor.js'
import { IterationOrchestrator } from '../runtime/query/iteration/index.js'
import { ActivityStore } from '../store/activity/memory.js'
import type { HITLResumeDecision } from '../types/hitl/index.js'
import type { RunId } from '../types/ids/index.js'
import type { Message } from '../types/message/index.js'
import type { RunEvent } from '../types/run/index.js'
import type { ToolRegistryContract } from '../types/tool/index.js'
import type { VerificationGateConfig } from '../types/verification/index.js'
import type { Logger } from '../utils/logger.js'
import { VerificationGate } from '../verification/gate.js'

/**
 * The loop driven the way the SHIPPED CLI drives it, with a human who says
 * no.
 *
 * This is the test that was missing. Every P0 in the hardening audit was a
 * defect on the default path, and every one of them was invisible because
 * the existing tests configured their way around it — the SDK default
 * `autoApproveHandler` means CI never once saw a rejection, so "every
 * decline kills the run" shipped and stayed shipped. The CLI wires a real
 * permission prompt straight onto `reject_tools`, so a user declining a
 * tool was the first thing to hit it.
 *
 * The assertion is deliberately end-state rather than mechanism: after the
 * turn, is the conversation still something a provider would accept?
 */

const RUN_ID = 'run_conformance' as RunId

/** The CLI's gate, verbatim in shape: read-only allowed, dangerous denied. */
const CLI_GATE: VerificationGateConfig = {
	enabled: true,
	rules: [],
	allowReadOnlyTools: true,
	denyDangerousPatterns: true,
	logDecisions: false,
}

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function harness(opts: { decision: HITLResumeDecision; turns: unknown[] }) {
	const messages: Message[] = []
	const executed: string[] = []
	let iteration = 0
	let stopReason: string | undefined
	const log = makeLogger()

	const defs: Record<string, boolean> = { read: true, bash: false, ls: true }

	const tools = {
		get: vi.fn((name: string) => ({
			name,
			category: defs[name] ? 'filesystem' : 'shell',
			isReadOnly: () => defs[name] === true,
			isDestructive: () => defs[name] !== true,
			isConcurrencySafe: () => defs[name] === true,
		})),
		execute: vi.fn(async (name: string) => {
			executed.push(name)
			return { success: true, output: `${name} ok` }
		}),
		has: vi.fn(() => true),
		listNames: vi.fn(() => Object.keys(defs)),
		getAvailability: vi.fn(() => 'active'),
		toLLMTools: vi.fn(() => []),
		register: vi.fn(),
		unregister: vi.fn(),
	} as unknown as ToolRegistryContract

	const activityStore = new ActivityStore(RUN_ID, {
		enabled: false,
		trackToolCalls: false,
		trackLlmTurns: false,
	})

	const runMgr = {
		id: RUN_ID,
		messages,
		tokenUsage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: {
			inputCostPer1M: 0,
			outputCostPer1M: 0,
			totalCost: 0,
			cacheDiscount: 0,
			unpricedTokens: 0,
		},
		get currentIteration() {
			return iteration
		},
		incrementIteration: () => ++iteration,
		pushMessage: (m: Message) => {
			messages.push(m)
		},
		recordTurnUsage: vi.fn(),
		accumulateUsage: vi.fn(),
		clearLastPromptTokens: vi.fn(),
		lastPromptTokens: undefined,
		setStopReason: (r: string) => {
			stopReason = r
		},
		setStructuredOutput: vi.fn(),
		markCancelled: vi.fn(),
		// LOG-14: a gate denial now calls `recordAudit` inside `runToolReview`
		// — the 'a gate denial...' and 'a human approval cannot release...'
		// tests below drive an actual denial through this stub, so it has to
		// answer the call or the loop throws mid-review instead of the
		// assertion running at all.
		recordAudit: vi.fn(async () => undefined as never),
	}

	const orchestrator = new IterationOrchestrator({
		provider: new MockLLMProvider({ turns: opts.turns as never }),
		// The CLI's runConfig shape: a huge cumulative budget and a model id.
		runConfig: { model: 'claude-opus-5', maxIterations: 50, tokenBudget: 1_000_000 },
		tools,
		runMgr,
		toolExecutor: new ToolExecutor(
			{
				tools,
				runId: RUN_ID,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
			},
			activityStore,
			async () => {},
			log,
		),
		activityStore,
		abortController: new AbortController(),
		log,
		emitEvent: async () => {},
		drainPending: function* (): Generator<RunEvent> {},
		checkpointMgr: { create: async () => ({ id: 'cp_1' }) },
		planManager: { active: undefined },
		// The CLI's permission prompt resolves to exactly this.
		resumeHandler: async () => opts.decision,
		verificationGate: new VerificationGate(CLI_GATE, log),
		guard: {
			beforeIteration: () => ({
				shouldStop: iteration >= 4,
				forceFinalize: false,
				isCancelled: false,
				stopReason: 'max_iterations',
			}),
		},
	} as never)

	return { orchestrator, messages, executed, stopReason: () => stopReason }
}

async function drain(o: IterationOrchestrator) {
	const gen = o.runLoop()
	let next = await gen.next()
	while (!next.done) next = await gen.next()
}

/**
 * The only question that matters: could the next provider request be sent?
 *
 * An unanswered `tool_use` is a protocol violation — the wire replies
 * `400 messages.N: Did not find 1 tool_result block(s)` — and with no
 * provider retry that ends the run.
 */
function expectSendableHistory(messages: Message[]) {
	const dangling = findDanglingMessages(messages)
	expect(dangling.assistantsWithUnmatchedCalls).toEqual([])
	expect(dangling.orphanedToolMessages).toEqual([])
	expect(dangling.isValid).toBe(true)
}

const READ_THEN_ANSWER = [
	{ toolCalls: [{ name: 'read', args: { path: 'a.txt' } }] },
	{ text: 'Here is what I found.' },
]

describe('the invariant check itself has teeth', () => {
	// Running the tests above against the pre-fix `tool-review.ts` makes them
	// crash on a shape change rather than fail on the assertion, which proves
	// incompatibility but not detection. So reproduce the exact history the
	// old code produced and show the check rejects it. Without this, a future
	// regression could weaken `expectSendableHistory` into something that
	// passes everything.
	it('rejects the history the old rejection path produced', () => {
		const brokenHistory: Message[] = [
			{ role: 'user', content: 'delete everything' },
			{
				role: 'assistant',
				content: null,
				toolCalls: [
					{ id: 'call_0', type: 'function', function: { name: 'bash', arguments: '{}' } },
				],
			},
			// What the four broken branches pushed instead of a tool_result.
			{ role: 'user', content: '[SYSTEM] Tool calls rejected: no' },
		]

		const dangling = findDanglingMessages(brokenHistory)
		expect(dangling.isValid).toBe(false)
		expect(dangling.assistantsWithUnmatchedCalls).toEqual([1])
		expect(() => expectSendableHistory(brokenHistory)).toThrow()
	})

	it('accepts the same turn once the call is answered', () => {
		const repaired: Message[] = [
			{ role: 'user', content: 'delete everything' },
			{
				role: 'assistant',
				content: null,
				toolCalls: [
					{ id: 'call_0', type: 'function', function: { name: 'bash', arguments: '{}' } },
				],
			},
			{ role: 'tool', toolCallId: 'call_0', content: 'Error: refused', isError: true },
		]

		expect(() => expectSendableHistory(repaired)).not.toThrow()
	})
})

describe('the CLI default path survives a human saying no', () => {
	it('a plain rejection leaves a conversation the provider would accept', async () => {
		const h = harness({
			decision: { action: 'reject_tools', feedback: 'Do not read that file.' },
			turns: [
				{ toolCalls: [{ name: 'bash', args: { command: 'ls -la' } }] },
				{ text: 'Understood.' },
			],
		})

		await drain(h.orchestrator)

		expectSendableHistory(h.messages)
		expect(h.executed).toEqual([])
		// And the feedback actually reached the model, in the slot it reads.
		expect(h.messages.some((m) => String(m.content).includes('Do not read that file'))).toBe(true)
	})

	it('a gate denial leaves a conversation the provider would accept', async () => {
		const h = harness({
			decision: { action: 'approve_tools' },
			turns: [
				// `rm -rf /` trips deny_dangerous_patterns in the CLI's gate.
				{ toolCalls: [{ name: 'bash', args: { command: 'rm -rf /' } }] },
				{ text: 'I will not do that.' },
			],
		})

		await drain(h.orchestrator)

		expectSendableHistory(h.messages)
		expect(h.executed).toEqual([])
	})

	it('a human approval cannot release a call the gate denied', async () => {
		const h = harness({
			decision: { action: 'approve_tools' },
			turns: [
				{
					toolCalls: [
						{ name: 'read', args: { path: 'a.txt' } },
						{ name: 'bash', args: { command: 'rm -rf /' } },
					],
				},
				{ text: 'Done what I could.' },
			],
		})

		await drain(h.orchestrator)

		// The gate's decision is the floor; approval covers only what it left
		// undecided.
		expect(h.executed).toEqual(['read'])
		expectSendableHistory(h.messages)
	})

	it('a partial deny answers the denied call too', async () => {
		const h = harness({
			decision: {
				action: 'modify_tools',
				modifications: [{ toolCallId: 'call_0_1', action: 'deny' }],
			} as HITLResumeDecision,
			turns: [
				{ toolCalls: [{ name: 'ls' }, { name: 'bash', args: { command: 'echo hi' } }] },
				{ text: 'ok' },
			],
		})

		await drain(h.orchestrator)

		expectSendableHistory(h.messages)
	})

	it('the approving path is unaffected', async () => {
		const h = harness({ decision: { action: 'approve_tools' }, turns: READ_THEN_ANSWER })

		await drain(h.orchestrator)

		expect(h.executed).toEqual(['read'])
		expect(h.stopReason()).toBe('end_turn')
		expectSendableHistory(h.messages)
	})
})
