import {
	ACPServer,
	ACP_PERMISSION_CAPABILITY,
	type AcpPermissionRequest,
	HostCommandRegistry,
	type MCPJsonRpcMessage,
	type MCPTransport,
	type Message,
	type RunEvent,
	ToolRegistry,
	asMessageId,
	asRunId,
	createAssistantMessage,
	createToolPresenter,
} from '@namzu/sdk'

import { describe, expect, it, vi } from 'vitest'

import type { AgentSessionOptions, SendOptions } from '../../tui/agent.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'
import type { CommandContext } from '../types.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function wirePair(): {
	readonly transport: MCPTransport
	readonly sent: MCPJsonRpcMessage[]
	deliver(message: MCPJsonRpcMessage): void
} {
	const sent: MCPJsonRpcMessage[] = []
	let handler: ((message: MCPJsonRpcMessage) => void) | undefined
	return {
		sent,
		deliver: (message) => handler?.(message),
		transport: {
			connect: async () => {},
			close: async () => {},
			send: async (message) => {
				sent.push(message)
			},
			onMessage: (next) => {
				handler = next
			},
			onClose: () => {},
			onError: () => {},
			isConnected: () => true,
		},
	}
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve))
}

async function waitForFrame(
	sent: readonly MCPJsonRpcMessage[],
	id: string | number,
): Promise<MCPJsonRpcMessage> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const frame = sent.find((message) => message.id === id)
		if (frame) return frame
		await settle()
	}
	throw new Error(`ACP frame ${String(id)} did not arrive`)
}

function context(config: CommandContext['config'] = {}): CommandContext {
	return {
		config,
		formatter: {
			name: 'text',
			print: () => {},
			info: () => {},
			error: () => {},
		},
	}
}

function event(text: string): RunEvent {
	return {
		type: 'text_delta',
		runId: asRunId(`run_acp_${text}`),
		messageId: asMessageId(`msg_acp_${text}`),
		iteration: 0,
		text,
	} as RunEvent
}

describe('the CLI ACP runtime', () => {
	it('settles a cancelled wire prompt while its late session candidate remains owned', async () => {
		const candidateA = deferred<{
			hasProvider: true
			errorHint: null
			mcpFailed: readonly []
			close: () => Promise<void>
			send: ReturnType<typeof vi.fn>
		}>()
		const startedA = deferred<void>()
		const closeA = vi.fn(async () => {
			throw new Error('late candidate close failed')
		})
		const sendA = vi.fn()
		const sendB = vi.fn(async function* () {
			yield { kind: 'done', stopReason: 'end_turn' } as const
		})
		const deps = {
			probe: vi.fn(async () => ({
				preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
				needsRepickReason: null,
				detected: [],
			})),
			createSession: vi.fn(async (_prefs, _detected, options: AgentSessionOptions) => {
				if (options.cwd === '/canonical/a') {
					startedA.resolve()
					return candidateA.promise
				}
				return {
					hasProvider: true as const,
					errorHint: null,
					mcpFailed: [],
					close: async () => {},
					send: sendB,
				}
			}),
			decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true as const, cwd }),
			resolveProjectContext: (ctx: CommandContext) => ctx,
		} as unknown as AcpRuntimeDependencies
		const runtime = createCliAcpRuntime(context(), deps)
		const wire = wirePair()
		const ids = ['session-a', 'session-b']
		const server = new ACPServer({
			transport: wire.transport,
			gateway: runtime.gateway,
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: 'test' },
			newSessionId: () => ids.shift() ?? 'unexpected-session',
		})

		await server.start()
		wire.deliver({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { capabilities: [ACP_PERMISSION_CAPABILITY] },
		})
		await waitForFrame(wire.sent, 1)
		wire.deliver({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/canonical/a' } })
		wire.deliver({ jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: '/canonical/b' } })
		await Promise.all([waitForFrame(wire.sent, 2), waitForFrame(wire.sent, 3)])

		wire.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/prompt',
			params: { sessionId: 'session-a', prompt: 'held' },
		})
		await startedA.promise
		wire.deliver({
			jsonrpc: '2.0',
			id: 5,
			method: 'session/prompt',
			params: { sessionId: 'session-b', prompt: 'independent' },
		})
		wire.deliver({
			jsonrpc: '2.0',
			id: 6,
			method: 'session/cancel',
			params: { sessionId: 'session-a' },
		})

		const firstOutcome = await Promise.race([
			Promise.all([waitForFrame(wire.sent, 4), waitForFrame(wire.sent, 5)]),
			new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 30)),
		])
		candidateA.resolve({
			hasProvider: true,
			errorHint: null,
			mcpFailed: [],
			close: closeA,
			send: sendA,
		})
		expect(firstOutcome).not.toBe('timed-out')
		if (firstOutcome === 'timed-out') throw new Error('cancelled prompt remained behind startup')
		expect(firstOutcome[0].result).toEqual({ stopReason: 'cancelled' })
		expect(firstOutcome[1].result).toEqual({ stopReason: 'end_turn' })
		await settle()
		expect(closeA).toHaveBeenCalledTimes(1)
		expect(sendA).not.toHaveBeenCalled()

		await server.stop()
		await runtime.close()
	})

	it('keeps cwd, config, events, permissions and settled history with their owning session', async () => {
		const aliases = new Map([
			['/alias/a', '/canonical/a'],
			['/alias/b', '/canonical/b'],
		])
		const starts = new Map([
			['/canonical/a', deferred<void>()],
			['/canonical/b', deferred<void>()],
		])
		const releases = new Map([
			['/canonical/a', deferred<void>()],
			['/canonical/b', deferred<void>()],
		])
		const optionsByCwd = new Map<string, AgentSessionOptions>()
		const sendsByCwd = new Map<string, (readonly Message[])[]>()
		const closeByCwd = new Map<string, ReturnType<typeof vi.fn>>()

		const createSession = vi.fn(
			async (_preferences: unknown, _detected: unknown, options: AgentSessionOptions) => {
				const cwd = options.cwd as string
				optionsByCwd.set(cwd, options)
				const sends: (readonly Message[])[] = []
				sendsByCwd.set(cwd, sends)
				const close = vi.fn(async () => {})
				closeByCwd.set(cwd, close)
				let turn = 0
				return {
					hasProvider: true,
					errorHint: null,
					mcpFailed: [],
					close,
					send: async function* (messages: readonly Message[], send?: SendOptions) {
						turn += 1
						sends.push(messages)
						starts.get(cwd)?.resolve()
						await releases.get(cwd)?.promise
						const input = { command: `echo ${cwd}`, hidden: `exact-${cwd}-${turn}` }
						await send?.onPermission?.({
							toolCalls: [
								{
									id: `call-${cwd}-${turn}`,
									name: 'bash',
									input,
									isDestructive: false,
								},
							],
						})
						const settled = [...messages, createAssistantMessage(`answer ${cwd} ${turn}`)]
						send?.onConversationMessages?.(settled)
						yield { kind: 'done', stopReason: 'end_turn' } as const
					},
				}
			},
		)

		const bootstrap = context()
		const deps = {
			probe: vi.fn(async () => ({
				preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
				needsRepickReason: null,
				detected: [],
			})),
			createSession,
			decideTrust: ({ cwd }: { cwd: string }) => ({
				allowed: true as const,
				cwd: aliases.get(cwd) ?? cwd,
			}),
			resolveProjectContext: (_ctx: CommandContext, cwd: string) =>
				context(
					cwd.endsWith('/a')
						? {
								permissions: { bash: 'deny' },
								mcpServers: { alpha: { command: 'alpha-server' } },
								plugins: { enabled: true, allowedScopes: ['project'] },
								sandbox: { enabled: true, teardownTimeoutMs: 101 },
							}
						: {
								permissions: { read: 'allow' },
								mcpServers: { beta: { command: 'beta-server' } },
								plugins: { enabled: true, allowedScopes: ['user'] },
								sandbox: { enabled: false, teardownTimeoutMs: 202 },
							},
				),
		} as unknown as AcpRuntimeDependencies
		const runtime = createCliAcpRuntime(bootstrap, deps)
		const routedA: RunEvent[] = []
		const routedB: RunEvent[] = []
		const permissionRequests: AcpPermissionRequest[] = []
		const ask = async (request: AcpPermissionRequest) => {
			permissionRequests.push(request)
			return { kind: 'approve' as const }
		}
		const signalA = new AbortController().signal
		const signalB = new AbortController().signal

		const turnA = runtime.gateway.prompt({
			sessionId: 'session-a',
			prompt: 'first a',
			cwd: '/alias/a',
			onEvent: (value) => routedA.push(value),
			signal: signalA,
			ask: ask as never,
			filesystem: undefined,
			history: [],
		})
		const turnB = runtime.gateway.prompt({
			sessionId: 'session-b',
			prompt: 'first b',
			cwd: '/alias/b',
			onEvent: (value) => routedB.push(value),
			signal: signalB,
			ask: ask as never,
			filesystem: undefined,
			history: [],
		})
		await Promise.race([
			Promise.all([starts.get('/canonical/a')?.promise, starts.get('/canonical/b')?.promise]),
			Promise.all([turnA, turnB]).then(() => {
				throw new Error('turns settled before their canonical sessions started')
			}),
		])

		const eventA = event('from-a')
		const eventB = event('from-b')
		optionsByCwd.get('/canonical/a')?.onRunEvent?.(eventA)
		optionsByCwd.get('/canonical/b')?.onRunEvent?.(eventB)
		expect(routedA).toEqual([eventA])
		expect(routedB).toEqual([eventB])

		releases.get('/canonical/a')?.resolve()
		releases.get('/canonical/b')?.resolve()
		const [resultA, resultB] = await Promise.all([turnA, turnB])
		expect(
			permissionRequests
				.map((request) => ({ sessionId: request.sessionId, input: request.toolCalls[0]?.input }))
				.sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
		).toEqual([
			{
				sessionId: 'session-a',
				input: { command: 'echo /canonical/a', hidden: 'exact-/canonical/a-1' },
			},
			{
				sessionId: 'session-b',
				input: { command: 'echo /canonical/b', hidden: 'exact-/canonical/b-1' },
			},
		])
		expect(createSession).toHaveBeenCalledTimes(2)
		expect(optionsByCwd.get('/canonical/a')).toEqual(
			expect.objectContaining({
				cwd: '/canonical/a',
				mcpServers: { alpha: { command: 'alpha-server' } },
				plugins: { enabled: true, allowedScopes: ['project'] },
				sandbox: { enabled: true, teardownTimeoutMs: 101 },
			}),
		)
		expect(optionsByCwd.get('/canonical/b')).toEqual(
			expect.objectContaining({
				cwd: '/canonical/b',
				mcpServers: { beta: { command: 'beta-server' } },
				plugins: { enabled: true, allowedScopes: ['user'] },
				sandbox: { enabled: false, teardownTimeoutMs: 202 },
			}),
		)
		expect(optionsByCwd.get('/canonical/a')?.rules).toEqual([
			{ type: 'deny_by_name', toolNames: ['bash'] },
		])

		await runtime.gateway.prompt({
			sessionId: 'session-a',
			prompt: 'second a',
			cwd: '/alias/a',
			onEvent: (value) => routedA.push(value),
			signal: signalA,
			ask: ask as never,
			filesystem: undefined,
			history: resultA.history ?? [],
		})
		expect(sendsByCwd.get('/canonical/a')?.[1]).toEqual([
			...(resultA.history as readonly Message[]),
			expect.objectContaining({ role: 'user', content: 'second a' }),
		])
		expect(resultB.history).not.toEqual(resultA.history)

		await expect(
			runtime.gateway.prompt({
				sessionId: 'session-a',
				prompt: 'wrong project',
				cwd: '/alias/b',
				onEvent: () => {},
				signal: signalA,
				ask: ask as never,
				filesystem: undefined,
				history: resultA.history ?? [],
			}),
		).rejects.toThrow('already owns /canonical/a')
		expect(createSession).toHaveBeenCalledTimes(2)

		await runtime.close()
		expect(closeByCwd.get('/canonical/a')).toHaveBeenCalledTimes(1)
		expect(closeByCwd.get('/canonical/b')).toHaveBeenCalledTimes(1)
	})

	it('closes a session candidate that resolves after connection teardown', async () => {
		const candidate = deferred<unknown>()
		const createStarted = deferred<void>()
		const close = vi.fn(async () => {})
		const send = vi.fn()
		const deps = {
			probe: vi.fn(async () => ({
				preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
				needsRepickReason: null,
				detected: [],
			})),
			createSession: vi.fn(async () => {
				createStarted.resolve()
				return candidate.promise
			}),
			decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true as const, cwd }),
			resolveProjectContext: (ctx: CommandContext) => ctx,
		} as unknown as AcpRuntimeDependencies
		const runtime = createCliAcpRuntime(context(), deps)
		const prompt = runtime.gateway.prompt({
			sessionId: 'late',
			prompt: 'x',
			cwd: '/canonical/late',
			onEvent: () => {},
			signal: new AbortController().signal,
			ask: async () => ({ kind: 'approve' }),
			filesystem: undefined,
			history: [],
		})
		await createStarted.promise
		await runtime.close()
		candidate.resolve({
			hasProvider: true,
			errorHint: null,
			mcpFailed: [],
			close,
			send,
		})

		await expect(prompt).rejects.toThrow('connection closed')
		expect(close).toHaveBeenCalledTimes(1)
		expect(send).not.toHaveBeenCalled()
	})

	it('reports the real aborted AgentSession event as a cancelled ACP prompt', async () => {
		const started = deferred<void>()
		const release = deferred<void>()
		const deps = {
			probe: vi.fn(async () => ({
				preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
				needsRepickReason: null,
				detected: [],
			})),
			createSession: vi.fn(async () => ({
				hasProvider: true,
				errorHint: null,
				mcpFailed: [],
				close: async () => {},
				send: async function* () {
					started.resolve()
					await release.promise
					yield { kind: 'error', message: 'aborted' } as const
				},
			})),
			decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true as const, cwd }),
			resolveProjectContext: (ctx: CommandContext) => ctx,
		} as unknown as AcpRuntimeDependencies
		const runtime = createCliAcpRuntime(context(), deps)
		const controller = new AbortController()
		const prompt = runtime.gateway.prompt({
			sessionId: 'cancelled',
			prompt: 'x',
			cwd: '/canonical/cancelled',
			onEvent: () => {},
			signal: controller.signal,
			ask: async () => ({ kind: 'approve' }),
			filesystem: undefined,
			history: [],
		})
		await started.promise
		controller.abort()
		release.resolve()

		expect(await prompt).toEqual({ stopReason: 'cancelled' })
		await runtime.close()
	})
})
