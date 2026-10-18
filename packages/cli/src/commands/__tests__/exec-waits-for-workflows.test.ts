import { describe, expect, it, vi } from 'vitest'

import type { Message } from '@namzu/sdk'
import { initialRunView } from '../../integrations/workflows/view.js'
import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import type { AgentEvent, AgentSession, SendOptions, SessionWorkflows } from '../../tui/agent.js'
import { execCommand } from '../exec.js'
import type { CommandContext } from '../types.js'

/**
 * `namzu exec` and a workflow the model started.
 *
 * Closing the session stops every run still going, so a headless run that
 * ended with its first turn killed the workflow before its first agent could
 * answer. It now waits for the run, hands the model the one message about it,
 * lets the model report, and only then closes the session.
 */

const sessionStub = fakeAgentSession()

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 2, provider: 'mock', subagents: { active: [] } },
		detected: [],
	})),
	createAgentSession: vi.fn(async () => sessionStub),
}))

/** The fixture's fields are read-only; a test decides what this session has. */
function withWorkflows(workflows: SessionWorkflows): void {
	;(sessionStub as { workflows?: SessionWorkflows }).workflows = workflows
}

function captured() {
	const printed: string[] = []
	const infos: string[] = []
	const errors: string[] = []
	const ctx = {
		formatter: {
			name: 'text' as const,
			print: (d: unknown) => printed.push(String((d as { text?: string })?.text ?? d)),
			info: (m: unknown) => infos.push(String(m)),
			error: (e: unknown) => errors.push(String((e as { message?: string })?.message ?? e)),
		},
		config: {} as Record<string, unknown>,
	}
	return { ctx, printed, infos, errors }
}

async function run(args: string[], config: Record<string, unknown> = {}) {
	const c = captured()
	c.ctx.config = config
	const code = (await execCommand.handler({
		rawArgs: args,
		ctx: c.ctx as unknown as CommandContext,
	} as never)) as number
	return { code, printed: c.printed, infos: c.infos, errors: c.errors }
}

function turn(events: unknown[]): AsyncIterable<AgentEvent> {
	return (async function* () {
		for (const e of events) yield e as AgentEvent
	})()
}

/** A workflows source whose single run ends when the test, or `idle()`, says so. */
function fakeWorkflows(
	options: { readonly endsOnIdle?: boolean; readonly agentTokens?: number } = {},
) {
	const endListeners = new Set<(end: { view: ReturnType<typeof endedView> }) => void>()
	let running = false
	const stops: string[] = []
	const endedView = (status: 'completed' | 'stopped') => ({
		...initialRunView({ runId: 'wrun00001', name: 'audit', description: 'd', phases: [], at: 0 }),
		status,
		endedAt: 5000,
		result: { fixed: 3 },
	})
	const end = (status: 'completed' | 'stopped' = 'completed') => {
		running = false
		for (const l of endListeners) l({ view: endedView(status) })
	}
	let signalWaiting: (() => void) | undefined
	const source = {
		runs: () => {
			const agents =
				options.agentTokens === undefined
					? []
					: [
							{
								index: 1,
								label: 'a',
								status: 'done' as const,
								queuedAt: 0,
								tokens: options.agentTokens,
								toolCalls: 0,
							},
						]
			if (running) return [{ ...endedView('completed'), status: 'running' as const, agents }]
			return options.agentTokens === undefined ? [] : [{ ...endedView('completed'), agents }]
		},
		subscribe: () => () => {},
		stop: (runId: string) => {
			stops.push(runId)
			end('stopped')
			signalWaiting?.()
			return true
		},
		skipAgent: () => false,
		agentOf: () => undefined,
		history: async () => [],
		onEnd: (l: (end: { view: ReturnType<typeof endedView> }) => void) => {
			endListeners.add(l)
			return () => endListeners.delete(l)
		},
		idle: async (signal?: AbortSignal) => {
			if (!running) return
			if (options.endsOnIdle) {
				await Promise.resolve()
				end()
				return
			}
			await new Promise<void>((resolve) => {
				signalWaiting = resolve
				signal?.addEventListener('abort', () => resolve(), { once: true })
			})
		},
		reset: () => {},
	}
	return {
		source: source as unknown as SessionWorkflows,
		start: () => {
			running = true
		},
		end,
		stops,
	}
}

describe('a headless run whose model starts a workflow', () => {
	it('waits for it, lets the model report, and closes the session only after', async () => {
		const flow = fakeWorkflows({ endsOnIdle: true })
		const order: string[] = []
		const sent: (readonly Message[])[] = []
		const options: (SendOptions | undefined)[] = []
		withWorkflows(flow.source)
		sessionStub.close = (async () => {
			order.push('close')
		}) as AgentSession['close']
		sessionStub.send = ((messages: readonly Message[], opts?: SendOptions) => {
			sent.push(messages)
			options.push(opts)
			order.push(`send ${sent.length}`)
			if (sent.length === 1) {
				flow.start()
				opts?.onConversationMessages?.([
					...messages,
					{ role: 'assistant', content: 'I started the audit.', timestamp: 1 },
				])
				return turn([
					{ kind: 'delta', text: 'I started the audit.' },
					{ kind: 'done', stopReason: 'end_turn' },
				])
			}
			return turn([
				{ kind: 'delta', text: 'The audit fixed 3 files.' },
				{ kind: 'done', stopReason: 'end_turn' },
			])
		}) as AgentSession['send']

		const { code, printed, infos } = await run(['audit everything'])

		expect(code).toBe(0)
		expect(order).toEqual(['send 1', 'send 2', 'close'])
		const report = sent[1]?.at(-1)
		expect(String(report?.content)).toContain('Workflow "audit" (wrun00001) completed.')
		expect(String(report?.content)).toContain('"fixed": 3')
		expect((report as { source?: unknown } | undefined)?.source).toEqual({
			type: 'runtime-context',
			kind: 'task-completion',
		})
		// The model sees its own first turn before the report.
		expect(sent[1]?.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
		// The answer the caller gets is the report, not the announcement.
		expect(printed.join('')).toBe('The audit fixed 3 files.')
		expect(infos.join('\n')).toContain('workflow finished')
		// A host that waits for background runs says so, or the tool is not offered.
		expect(options[0]?.workflowReview?.currentPermissionMode()).toBe('auto')
		expect(options[0]?.workflowReview?.onPermission).toBeUndefined()
	})

	it('takes one turn, and does not wait, when no workflow was started', async () => {
		const flow = fakeWorkflows()
		let sends = 0
		withWorkflows(flow.source)
		sessionStub.send = (() => {
			sends += 1
			return turn([
				{ kind: 'delta', text: 'done.' },
				{ kind: 'done', stopReason: 'end_turn' },
			])
		}) as AgentSession['send']
		const { code, printed } = await run(['hello'])
		expect(code).toBe(0)
		expect(sends).toBe(1)
		expect(printed.join('')).toBe('done.')
	})

	it('stops a run that outlasts the turn limit and reports it as stopped', async () => {
		const flow = fakeWorkflows()
		const sent: (readonly Message[])[] = []
		withWorkflows(flow.source)
		sessionStub.send = ((messages: readonly Message[]) => {
			sent.push(messages)
			if (sent.length === 1) {
				flow.start()
				return turn([{ kind: 'done', stopReason: 'end_turn' }])
			}
			return turn([
				{ kind: 'delta', text: 'It was cut short.' },
				{ kind: 'done', stopReason: 'end_turn' },
			])
		}) as AgentSession['send']
		const { code, printed } = await run(['go'], { limits: { timeoutMs: 20 } })
		expect(code).toBe(0)
		expect(flow.stops).toEqual(['wrun00001'])
		expect(String(sent[1]?.at(-1)?.content)).toContain('was stopped')
		expect(printed.join('')).toBe('It was cut short.')
	})

	it('does not wait when the first turn failed', async () => {
		const flow = fakeWorkflows({ endsOnIdle: true })
		let sends = 0
		withWorkflows(flow.source)
		sessionStub.send = (() => {
			sends += 1
			flow.start()
			return turn([{ kind: 'error', message: 'provider down' }])
		}) as AgentSession['send']
		const { code } = await run(['go'])
		expect(code).toBe(1)
		expect(sends).toBe(1)
	})

	it('prints what the whole command spent, the reporting turn and the workflow agents included', async () => {
		const flow = fakeWorkflows({ endsOnIdle: true, agentTokens: 40_000 })
		let sends = 0
		withWorkflows(flow.source)
		const budget = (own: number) => ({
			limit: 0,
			ownTokens: own,
			treeTokens: own,
			reservedTokens: 0,
			remainingTokens: null,
			inFlightRequests: 0,
			unsettledChildren: 0,
			poisoned: false,
			unresolvedRequests: 0,
		})
		sessionStub.send = ((_messages: readonly Message[], opts?: SendOptions) => {
			sends += 1
			if (sends === 1) {
				flow.start()
				opts?.onConversationMessages?.([])
				return turn([{ kind: 'done', stopReason: 'end_turn', budget: budget(90_000) }])
			}
			return turn([
				{ kind: 'delta', text: 'reported.' },
				{ kind: 'done', stopReason: 'end_turn', budget: budget(7_000) },
			])
		}) as AgentSession['send']
		const { code, infos } = await run(['audit everything'])
		expect(code).toBe(0)
		// 90 000 + 7 000 over the two turns; the run's 40 000 joins the descendants only.
		expect(infos).toContain('Tokens: 97000 own · 137000 including descendants')
	})
})
