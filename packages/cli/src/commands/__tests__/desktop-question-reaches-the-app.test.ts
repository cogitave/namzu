import {
	ACPServer,
	ACP_PERMISSION_CAPABILITY,
	HostCommandRegistry,
	type MCPJsonRpcMessage,
	type MCPTransport,
	type Message,
	ToolManager,
	createToolPresenter,
} from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import type {
	AgentSessionOptions,
	QuestionAnswer,
	SendOptions,
	UserQuestion,
} from '../../tui/agent.js'
import {
	ANSWER_QUESTION_METHOD,
	QUESTION_CLOSED_NOTIFICATION,
	QUESTION_NOTIFICATION,
	createQuestionRelay,
	readQuestionAnswer,
	routeQuestions,
} from '../acp-desktop-question.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime, resolveAcpSession } from '../acp.js'
import type { CommandContext } from '../types.js'

/**
 * A Desktop conversation asks the person through the app, and the answer the person gives is the
 * answer the model reads. The model here is a fake: its session calls the turn's `onQuestion` the
 * way the real `ask_user_question` tool does, and each kind of request it makes is told apart
 * (the question, the history lookup the kernel makes beside it, the turn itself).
 */

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function wirePair() {
	const sent: MCPJsonRpcMessage[] = []
	let handler: ((message: MCPJsonRpcMessage) => void) | undefined
	const frames = new Map<string | number, ReturnType<typeof deferred<MCPJsonRpcMessage>>>()
	const frame = (id: string | number) => {
		let wait = frames.get(id)
		if (!wait) {
			wait = deferred<MCPJsonRpcMessage>()
			frames.set(id, wait)
		}
		return wait
	}
	const transport: MCPTransport = {
		connect: async () => {},
		close: async () => {},
		send: async (message) => {
			sent.push(message)
			if (message.id !== undefined) frame(message.id).resolve(message)
		},
		onMessage: (next) => {
			handler = next
		},
		onClose: () => {},
		onError: () => {},
		isConnected: () => true,
	}
	return {
		transport,
		sent,
		deliver: (message: MCPJsonRpcMessage) => handler?.(message),
		reply: (id: string | number) => frame(id).promise,
	}
}

const context = (): CommandContext => ({
	config: {},
	formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} },
})

const unclaimed = (wireSessionId: string) => resolveAcpSession(wireSessionId, async () => undefined)

const QUESTION: UserQuestion = {
	questionId: 'toolu_1',
	question: 'Who is the audience?',
	header: 'Audience',
	multiSelect: false,
	allowFreeText: true,
	options: [
		{ id: 'opt_1', label: 'Board', recommended: true },
		{ id: 'opt_2', label: 'Engineers' },
	],
}

const BATCH: UserQuestion = {
	...QUESTION,
	questions: [
		{
			id: 'toolu_1#0',
			question: 'Who is the audience?',
			header: 'Audience',
			multiSelect: false,
			allowFreeText: true,
			options: QUESTION.options,
		},
		{
			id: 'toolu_1#1',
			question: 'Which environments?',
			header: 'Environment',
			multiSelect: true,
			allowFreeText: false,
			options: [
				{ id: 'opt_1', label: 'Staging' },
				{ id: 'opt_2', label: 'Production' },
			],
		},
	],
}

interface Harness {
	readonly runtime: ReturnType<typeof createCliAcpRuntime>
	readonly wire: ReturnType<typeof wirePair>
	readonly server: ACPServer
	readonly notices: { method: string; params: Record<string, unknown> }[]
	readonly options: AgentSessionOptions[]
	readonly asked: ReturnType<typeof deferred<Record<string, unknown>>>
	readonly closed: ReturnType<typeof deferred<Record<string, unknown>>>
	readonly outcome: ReturnType<typeof deferred<QuestionAnswer | undefined>>
	readonly sends: Message[][]
}

async function start(
	question: UserQuestion,
	runtimeOptions: Parameters<typeof createCliAcpRuntime>[2],
): Promise<Harness> {
	const options: AgentSessionOptions[] = []
	const sends: Message[][] = []
	const outcome = deferred<QuestionAnswer | undefined>()
	const deps = {
		probe: vi.fn(async () => ({
			preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
			needsRepickReason: null,
			detected: [],
		})),
		createSession: vi.fn(async (_p: unknown, _d: unknown, sessionOptions: AgentSessionOptions) => {
			options.push(sessionOptions)
			return {
				hasProvider: true as const,
				errorHint: null,
				mcpFailed: [],
				close: async () => {},
				send: async function* (messages: readonly Message[], send?: SendOptions) {
					sends.push([...messages])
					// The model calls the question tool; the tool asks the turn's answerer and waits.
					const answer = await send?.onQuestion?.(question)
					outcome.resolve(answer)
					yield { kind: 'done', stopReason: 'end_turn' } as const
				},
			}
		}),
		decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true as const, cwd }),
		resolveProjectContext: (ctx: CommandContext) => ctx,
		resolveSession: unclaimed,
	} as unknown as AcpRuntimeDependencies
	const notices: Harness['notices'] = []
	const asked = deferred<Record<string, unknown>>()
	const closed = deferred<Record<string, unknown>>()
	const runtime = createCliAcpRuntime(context(), deps, {
		...runtimeOptions,
		announce: (method, params) => {
			notices.push({ method, params })
			if (method === QUESTION_NOTIFICATION) asked.resolve(params)
			if (method === QUESTION_CLOSED_NOTIFICATION) closed.resolve(params)
		},
	})
	const wire = wirePair()
	const server = new ACPServer({
		transport: wire.transport,
		gateway: runtime.gateway,
		commands: new HostCommandRegistry(),
		presenter: createToolPresenter(new ToolManager({ toolsets: [], messages: () => [] })),
		agentInfo: { name: 'namzu', version: 'test' },
		newSessionId: () => 'session-a',
	})
	await server.start()
	wire.deliver({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: { capabilities: [ACP_PERMISSION_CAPABILITY] },
	})
	await wire.reply(1)
	wire.deliver({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/canonical/a' } })
	await wire.reply(2)
	return { runtime, wire, server, notices, options, asked, closed, outcome, sends }
}

const prompt = (h: Harness) =>
	h.wire.deliver({
		jsonrpc: '2.0',
		id: 3,
		method: 'session/prompt',
		params: { sessionId: 'session-a', prompt: 'make the deck' },
	})

describe('a Desktop conversation asks the person', () => {
	it('mounts the question tool without what the terminal brings with it, and sends the question to the app', async () => {
		const h = await start(QUESTION, {})
		prompt(h)
		const params = await h.asked.promise
		expect(h.options[0]?.questions).toBe(true)
		// The terminal's own switch is not turned on: no background agents, no `!` line.
		expect(h.options[0]?.askUser).toBeUndefined()
		expect(params.sessionId).toBe('session-a')
		expect(typeof params.requestId).toBe('string')
		expect(params.question).toMatchObject({ question: 'Who is the audience?' })

		h.runtime.answerQuestion?.('session-a', params.requestId as string, {
			kind: 'answer',
			selectedOptionIds: [],
			answers: [
				{ questionId: 'toolu_1', selectedOptionIds: ['opt_2'], freeText: '  the sales team ' },
			],
		})
		await h.wire.reply(3)
		// A lone question is answered at the top level, and the words arrive trimmed.
		expect(await h.outcome.promise).toEqual({
			kind: 'answer',
			selectedOptionIds: ['opt_2'],
			freeText: 'the sales team',
		})
		await h.server.stop()
		await h.runtime.close()
	})

	it('returns one answer per question of a batch, as the tool documents', async () => {
		const h = await start(BATCH, {})
		prompt(h)
		const params = await h.asked.promise
		h.runtime.answerQuestion?.('session-a', params.requestId as string, {
			kind: 'answer',
			selectedOptionIds: [],
			answers: [
				{ questionId: 'toolu_1#0', selectedOptionIds: ['opt_1'] },
				{ questionId: 'toolu_1#1', selectedOptionIds: ['opt_1', 'opt_2'] },
			],
		})
		await h.wire.reply(3)
		expect(await h.outcome.promise).toEqual({
			kind: 'answer',
			selectedOptionIds: [],
			answers: [
				{ questionId: 'toolu_1#0', selectedOptionIds: ['opt_1'] },
				{ questionId: 'toolu_1#1', selectedOptionIds: ['opt_1', 'opt_2'] },
			],
		})
		await h.server.stop()
		await h.runtime.close()
	})

	it('reports a skip as no answer, and refuses a second answer to the same question', async () => {
		const h = await start(QUESTION, {})
		prompt(h)
		const params = await h.asked.promise
		h.runtime.answerQuestion?.('session-a', params.requestId as string, { kind: 'skip' })
		await h.wire.reply(3)
		expect(await h.outcome.promise).toEqual({ kind: 'skip' })
		expect(() =>
			h.runtime.answerQuestion?.('session-a', params.requestId as string, { kind: 'skip' }),
		).toThrow('no longer open')
		await h.server.stop()
		await h.runtime.close()
	})

	it('stops asking when the turn is cancelled, and tells the app the question is closed', async () => {
		const h = await start(QUESTION, {})
		prompt(h)
		const params = await h.asked.promise
		h.wire.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/cancel',
			params: { sessionId: 'session-a' },
		})
		const closed = await h.closed.promise
		expect(closed).toEqual({ sessionId: 'session-a', requestId: params.requestId })
		expect(await h.outcome.promise).toEqual({ kind: 'abort' })
		await h.wire.reply(3)
		await h.server.stop()
		await h.runtime.close()
	})

	it('keeps the screen question on its own card and every other question on the relay', async () => {
		const screen = vi.fn(
			async (): Promise<QuestionAnswer> => ({ kind: 'answer', selectedOptionIds: ['allow'] }),
		)
		const other = vi.fn(async (): Promise<QuestionAnswer> => ({ kind: 'skip' }))
		const route = routeQuestions(screen, other)
		if (!route) throw new Error('no route')
		await route(QUESTION)
		expect(other).toHaveBeenCalledTimes(1)
		expect(screen).not.toHaveBeenCalled()
		expect(routeQuestions(undefined, undefined)).toBeUndefined()
		expect(routeQuestions(screen, undefined)).toBe(screen)
		expect(routeQuestions(undefined, other)).toBe(other)
	})
})

describe('the question relay', () => {
	it('does not take an answer for another conversation, an unreadable one, or one that closed', async () => {
		const notices: { method: string; params: Record<string, unknown> }[] = []
		const relay = createQuestionRelay((method, params) => notices.push({ method, params }))
		const controller = new AbortController()
		const waiting = relay.forTurn('a', controller.signal)(QUESTION)
		const requestId = notices[0]?.params.requestId as string
		expect(relay.answer('b', requestId, { kind: 'skip' })).toBe(false)
		expect(relay.answer('a', requestId, { kind: 'answer', selectedOptionIds: 'opt_1' })).toBe(false)
		expect(relay.answer('a', requestId, { kind: 'maybe' })).toBe(false)
		expect(relay.answer('a', requestId, { kind: 'skip' })).toBe(true)
		expect(await waiting).toEqual({ kind: 'skip' })
		expect(relay.answer('a', requestId, { kind: 'skip' })).toBe(false)
	})

	it('answers abort at once for a turn that has already stopped, and skip for a caller that gave up', async () => {
		const relay = createQuestionRelay(() => {})
		const stopped = new AbortController()
		stopped.abort()
		expect(await relay.forTurn('a', stopped.signal)(QUESTION)).toEqual({ kind: 'abort' })
		const gaveUp = new AbortController()
		const notices: string[] = []
		const live = createQuestionRelay((method) => notices.push(method))
		const waiting = live.forTurn('a', new AbortController().signal)(QUESTION, gaveUp.signal)
		gaveUp.abort()
		expect(await waiting).toEqual({ kind: 'skip' })
		expect(notices).toEqual([QUESTION_NOTIFICATION, QUESTION_CLOSED_NOTIFICATION])
	})

	it('reads an answer strictly', () => {
		expect(
			readQuestionAnswer({ kind: 'answer', selectedOptionIds: ['opt_1'], freeText: '   ' }),
		).toEqual({
			kind: 'answer',
			selectedOptionIds: ['opt_1'],
		})
		expect(readQuestionAnswer({ kind: 'answer', selectedOptionIds: [1] })).toBeUndefined()
		expect(
			readQuestionAnswer({ kind: 'answer', answers: [{ selectedOptionIds: [] }] }),
		).toBeUndefined()
		expect(readQuestionAnswer(null)).toBeUndefined()
		expect(ANSWER_QUESTION_METHOD).toBe('namzu/session/answer-question')
	})
})
