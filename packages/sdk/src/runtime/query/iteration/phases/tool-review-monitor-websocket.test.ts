import { describe, expect, it, vi } from 'vitest'

import { AuthorizationGate } from '../../../../authorization/gate.js'
import { ActivityStore } from '../../../../store/activity/memory.js'
import { MonitorTool } from '../../../../tools/builtins/monitor.js'
import type { ToolManager } from '../../../../toolsets/manager.js'
import type {
	AuthorizationGateConfig,
	AuthorizationRule,
} from '../../../../types/authorization/index.js'
import type { HITLDecisionRequest, HITLResumeDecision } from '../../../../types/hitl/index.js'
import type { TurnId } from '../../../../types/ids/index.js'
import type { Message } from '../../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../../types/provider/index.js'
import type { ToolDefinition } from '../../../../types/tool/index.js'
import { generateSessionId } from '../../../../utils/id.js'
import type { Logger } from '../../../../utils/logger.js'
import { ToolExecutor } from '../../executor.js'
import { type ToolReviewPrompt, createReviewHandler } from '../../review-policy.js'
import type { IterationContext } from './context.js'
import { runToolReview } from './tool-review.js'

/**
 * How the review path treats a call to the real `monitor` tool.
 *
 * A permission rule written for commands reads the `command` argument, and a
 * WebSocket call has none, so such a rule has nothing to allow it with. And
 * the rules that do not read the argument (a rule for the tool by name, for the
 * shell category the sandboxed-shell preset allows) cannot let the connection
 * skip a person either, because the tool declares `requiresApproval` for it.
 * The same rules still allow the command form, which is the point of declaring
 * it per call and not per tool.
 */

const SESSION_ID = generateSessionId()
const TURN_ID = 'b7e0c1a2-3d4e-4f5a-9b6c-7d8e9f0a1b2c' as TurnId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

const DEFINITIONS: Record<string, ToolDefinition> = {
	monitor: MonitorTool as unknown as ToolDefinition,
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

const COMMAND = { description: 'watch', command: 'tail -f app.log' }
const SOCKET = { description: 'watch', ws: { url: 'wss://events.example/stream' } }

/** A rule written the way an operator writes one for commands: any `tail`, allowed. */
const TAIL_RULE: AuthorizationRule = {
	type: 'argument_pattern',
	toolNames: ['monitor'],
	argument: 'command',
	pattern: '^tail ',
	decision: 'allow',
}

function approver() {
	const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
	const handler = createReviewHandler({
		mode: 'prompt',
		prompt,
		registry: {
			get: (name: string) => DEFINITIONS[name],
			sourceOf: () => ({ id: 'test', kind: 'host_tool' as const }),
		},
	})
	return { prompt, handler }
}

describe('a command rule cannot auto-allow a WebSocket monitor', () => {
	it('allows the command it was written for without asking anyone', async () => {
		const { prompt, handler } = approver()
		const t = turn({ gate: gateConfig({ rules: [TAIL_RULE] }), resumeHandler: handler })

		expect(await run(t, response('monitor', COMMAND))).toBe('executed')
		expect(prompt).not.toHaveBeenCalled()
	})

	it('asks a person about the same tool called with a WebSocket, and runs it only after approval', async () => {
		const { prompt, handler } = approver()
		const t = turn({ gate: gateConfig({ rules: [TAIL_RULE] }), resumeHandler: handler })

		expect(await run(t, response('monitor', SOCKET))).toBe('executed')
		expect(prompt).toHaveBeenCalledTimes(1)
		expect(prompt.mock.calls[0]?.[0].toolCalls[0]?.requiresApproval).toBe(true)
	})

	it('is refused, not run, when the person declines', async () => {
		const resumeHandler = createReviewHandler({
			mode: 'prompt',
			prompt: async () => ({ kind: 'reject', feedback: 'no' }),
			registry: {
				get: (name: string) => DEFINITIONS[name],
				sourceOf: () => ({ id: 'test', kind: 'host_tool' as const }),
			},
		})
		const t = turn({ gate: gateConfig({ rules: [TAIL_RULE] }), resumeHandler })

		expect(await run(t, response('monitor', SOCKET))).toBe('rejected')
		expect(t.executed).toEqual([])
	})
})

describe('a rule that does not read the command cannot let the connection through either', () => {
	it('is asked about although the whole shell category is allowed', async () => {
		const { prompt, handler } = approver()
		const t = turn({
			gate: gateConfig({ rules: [{ type: 'allow_by_category', categories: ['shell'] }] }),
			resumeHandler: handler,
		})

		expect(await run(t, response('monitor', COMMAND))).toBe('executed')
		expect(prompt).not.toHaveBeenCalled()
		expect(await run(t, response('monitor', SOCKET))).toBe('executed')
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('is asked about although the tool is allowed by name', async () => {
		const { prompt, handler } = approver()
		const t = turn({
			gate: gateConfig({ rules: [{ type: 'allow_by_name', toolNames: ['monitor'] }] }),
			resumeHandler: handler,
		})

		expect(await run(t, response('monitor', SOCKET))).toBe('executed')
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('is refused with nobody to ask, even in auto mode', async () => {
		const handler = createReviewHandler({
			mode: 'auto',
			registry: {
				get: (name: string) => DEFINITIONS[name],
				sourceOf: () => ({ id: 'test', kind: 'host_tool' as const }),
			},
		})
		const t = turn({
			gate: gateConfig({ rules: [{ type: 'allow_by_category', categories: ['shell'] }] }),
			resumeHandler: handler,
		})

		expect(await run(t, response('monitor', SOCKET))).toBe('rejected')
		expect(t.executed).toEqual([])
	})
})
