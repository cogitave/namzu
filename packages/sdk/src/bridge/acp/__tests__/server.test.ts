import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
	ACP_ERROR_CODES,
	ACP_METHODS,
	ACP_PERMISSION_CAPABILITY,
	ACP_PROTOCOL_VERSION,
} from '../../../constants/acp/index.js'
import { HostCommandRegistry } from '../../../registry/command/index.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { createToolPresenter } from '../../../registry/tool/presentation.js'
import { fixtureId } from '../../../test-support/ids.js'
import type { MCPJsonRpcMessage, MCPTransport } from '../../../types/connector/mcp.js'
import type { RunEvent } from '../../../types/run/events.js'
import { ACPServer, type AcpAgentGateway } from '../server.js'

/**
 * The wire surface an editor or an orchestrator drives.
 *
 * The precedent this whole module answers is `MCPServer`: a complete
 * protocol server that nothing in the tree ever constructed. So the tests
 * that matter most here are the ones about being DRIVEN — the method set
 * matching what is advertised, an unknown method not killing the
 * connection, and a session refusing to exist when it could not ask a human
 * anything.
 */

function pair(): {
	transport: MCPTransport
	sent: MCPJsonRpcMessage[]
	deliver(message: MCPJsonRpcMessage): void
} {
	const sent: MCPJsonRpcMessage[] = []
	let handler: ((m: MCPJsonRpcMessage) => void) | undefined
	return {
		sent,
		deliver: (m) => handler?.(m),
		transport: {
			connect: async () => {},
			close: async () => {},
			send: async (m) => {
				sent.push(m)
			},
			onMessage: (h) => {
				handler = h
			},
			onClose: () => {},
			onError: () => {},
			isConnected: () => true,
		},
	}
}

function build(
	over: {
		gateway?: Partial<AcpAgentGateway>
		commands?: HostCommandRegistry
	} = {},
) {
	const wire = pair()
	const gateway: AcpAgentGateway = {
		prompt: over.gateway?.prompt ?? (async () => ({ stopReason: 'end_turn' })),
	}
	const server = new ACPServer({
		transport: wire.transport,
		gateway,
		commands: over.commands ?? new HostCommandRegistry(),
		presenter: createToolPresenter(new ToolRegistry()),
		agentInfo: { name: 'namzu', version: '0.0.0-test' },
		newSessionId: () => 'ses_acp_fixed',
	})
	return { ...wire, server }
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve))
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

async function handshake(
	fixture: ReturnType<typeof build>,
	capabilities = [ACP_PERMISSION_CAPABILITY],
) {
	await fixture.server.start()
	fixture.deliver({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities } })
	await settle()
	fixture.deliver({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} })
	await settle()
	return fixture.sent.find((m) => m.id === 2)
}

describe('the method set cannot drift from the pinned protocol', () => {
	it('has a handler for every advertised method, and advertises every handler', async () => {
		const { server } = build()

		const declared = [...Object.values(ACP_METHODS)].sort()
		const implemented = [...server.methodNames()].sort()

		// BOTH directions, from two independently authored tables. Deriving the
		// handlers from `ACP_METHODS` would make this a tautology — the shape
		// `a-check-that-cannot-fail` is about.
		expect(implemented).toEqual(declared)
	})
})

describe('an unknown method', () => {
	it('answers -32601 and leaves the connection open', async () => {
		const fixture = build()
		await fixture.server.start()

		fixture.deliver({ jsonrpc: '2.0', id: 7, method: 'session/teleport' })
		await settle()

		const reply = fixture.sent.find((m) => m.id === 7)
		expect(reply?.error?.code).toBe(ACP_ERROR_CODES.METHOD_NOT_FOUND)
		// It names what IS implemented, so a client probing for a feature is
		// told where it stands rather than only that it guessed wrong.
		expect(reply?.error?.message).toContain('session/prompt')

		// Still alive: the next real call is answered. A bridge that closed on
		// an unrecognised method would make a feature probe fatal.
		fixture.deliver({ jsonrpc: '2.0', id: 8, method: 'initialize', params: {} })
		await settle()
		expect(fixture.sent.find((m) => m.id === 8)?.result).toBeDefined()
	})

	it('does not answer a notification it cannot handle, and survives it', async () => {
		const fixture = build()
		await fixture.server.start()

		// No `id`: a notification. There is nowhere to send an error, and
		// inventing a frame the client never asked for is worse than logging.
		fixture.deliver({ jsonrpc: '2.0', method: 'session/teleport' })
		await settle()
		expect(fixture.sent).toHaveLength(0)

		fixture.deliver({ jsonrpc: '2.0', id: 9, method: 'initialize', params: {} })
		await settle()
		expect(fixture.sent.find((m) => m.id === 9)?.result).toBeDefined()
	})
})

describe('initialize', () => {
	it('reports the pinned version and the capability it requires', async () => {
		const fixture = build()
		await fixture.server.start()

		fixture.deliver({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
		await settle()

		const result = fixture.sent.find((m) => m.id === 1)?.result as {
			protocolVersion: number
			requiredClientCapabilities: string[]
		}
		expect(result.protocolVersion).toBe(ACP_PROTOCOL_VERSION)
		expect(result.requiredClientCapabilities).toContain(ACP_PERMISSION_CAPABILITY)
	})

	it('reports the command surface from the registry, not a list of its own', async () => {
		const commands = new HostCommandRegistry()
		commands.register({
			name: 'weather',
			description: 'a command registered by the host, after this module was written',
			handler: () => ({ kind: 'ack', message: 'sunny' }),
		})
		const fixture = build({ commands })
		await fixture.server.start()

		fixture.deliver({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
		await settle()

		const result = fixture.sent.find((m) => m.id === 1)?.result as {
			commands: { name: string }[]
		}
		// The concrete test of whether the descriptor works: a command this
		// module has never heard of appears because the registry knows it.
		// Hard-coding a list here fails this.
		expect(result.commands.map((c) => c.name)).toEqual(['weather'])
		// And the handler does not cross the wire — it would not survive
		// `JSON.stringify` anyway, and a client receiving `handler: undefined`
		// learns nothing.
		expect(result.commands[0]).not.toHaveProperty('handler')
	})
})

describe('session/new', () => {
	it('REFUSES a client that declared no permission capability, naming it', async () => {
		const fixture = build()
		await fixture.server.start()
		fixture.deliver({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: [] } })
		await settle()

		fixture.deliver({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} })
		await settle()

		const reply = fixture.sent.find((m) => m.id === 2)
		// Not an auto-approving session. A session that cannot ask a human
		// anything and runs every tool regardless is the OPPOSITE of asking,
		// arrived at by omission — `refuse-do-not-degrade`.
		expect(reply?.error?.code).toBe(ACP_ERROR_CODES.INVALID_REQUEST)
		expect(reply?.error?.message).toContain(ACP_PERMISSION_CAPABILITY)
		expect(reply?.result).toBeUndefined()
	})

	it('creates one when the capability is declared', async () => {
		const fixture = build()
		const reply = await handshake(fixture)
		expect((reply?.result as { sessionId: string }).sessionId).toBe('ses_acp_fixed')
	})

	it('refuses before initialize', async () => {
		const fixture = build()
		await fixture.server.start()
		fixture.deliver({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} })
		await settle()
		expect(fixture.sent.find((m) => m.id === 1)?.error?.code).toBe(ACP_ERROR_CODES.INVALID_REQUEST)
	})

	it('refuses a relative cwd before publishing a session', async () => {
		const fixture = build()
		await fixture.server.start()
		fixture.deliver({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { capabilities: [ACP_PERMISSION_CAPABILITY] },
		})
		await settle()
		fixture.deliver({
			jsonrpc: '2.0',
			id: 2,
			method: 'session/new',
			params: { cwd: 'relative/project' },
		})
		await settle()

		const refusal = fixture.sent.find((m) => m.id === 2)?.error
		expect(refusal?.code).toBe(ACP_ERROR_CODES.INVALID_PARAMS)
		expect(refusal?.message).toContain('absolute path')
	})
})

describe('session/prompt', () => {
	it('streams updates and answers with the stop reason', async () => {
		const RID = fixtureId.run('acp')
		const fixture = build({
			gateway: {
				prompt: async ({ onEvent }) => {
					onEvent({
						type: 'text_delta',
						runId: RID,
						iteration: 0,
						messageId: fixtureId.message('a'),
						text: 'hello ',
					} as RunEvent)
					onEvent({
						type: 'text_delta',
						runId: RID,
						iteration: 0,
						messageId: fixtureId.message('a'),
						text: 'peer',
					} as RunEvent)
					return { stopReason: 'end_turn' }
				},
			},
		})
		await handshake(fixture)

		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: 'ses_acp_fixed', prompt: 'hi' },
		})
		await settle()

		const chunks = fixture.sent
			.filter((m) => m.method === 'session/update')
			.map((m) => (m.params as { update: { text?: string } }).update.text)
		expect(chunks).toEqual(['hello ', 'peer'])
		expect(fixture.sent.find((m) => m.id === 3)?.result).toEqual({ stopReason: 'end_turn' })
	})

	it('refuses a prompt for a session that does not exist', async () => {
		const fixture = build()
		await handshake(fixture)

		fixture.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/prompt',
			params: { sessionId: 'ses_never_made', prompt: 'hi' },
		})
		await settle()

		expect(fixture.sent.find((m) => m.id === 4)?.error?.code).toBe(ACP_ERROR_CODES.INVALID_PARAMS)
	})

	it('publishes a settled history to that session and copies it before the next prompt', async () => {
		const histories: (readonly unknown[])[] = []
		const returned = [{ role: 'user', content: 'first' }]
		const fixture = build({
			gateway: {
				prompt: async ({ history }) => {
					histories.push(history)
					return histories.length === 1
						? { stopReason: 'end_turn', history: returned }
						: { stopReason: 'end_turn' }
				},
			},
		})
		await handshake(fixture)

		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: 'ses_acp_fixed', prompt: 'first' },
		})
		await settle()
		returned.push({ role: 'user', content: 'mutated after publication' })
		fixture.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/prompt',
			params: { sessionId: 'ses_acp_fixed', prompt: 'second' },
		})
		await settle()

		expect(histories).toEqual([[], [{ role: 'user', content: 'first' }]])
	})

	it('refuses a gateway history replacement that is not an array', async () => {
		const fixture = build({
			gateway: {
				prompt: async () => ({
					stopReason: 'end_turn',
					history: { role: 'user', content: 'not a conversation' } as unknown as readonly unknown[],
				}),
			},
		})
		await handshake(fixture)

		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: 'ses_acp_fixed', prompt: 'first' },
		})
		await settle()

		expect(fixture.sent.find((frame) => frame.id === 3)?.error).toMatchObject({
			code: ACP_ERROR_CODES.INTERNAL_ERROR,
			message: expect.stringContaining('invalid history'),
		})
	})

	it('refuses a second live prompt before replacing the controller owned by the first', async () => {
		const release = deferred<void>()
		const signals: AbortSignal[] = []
		const fixture = build({
			gateway: {
				prompt: async ({ signal }) => {
					signals.push(signal)
					await release.promise
					return { stopReason: signal.aborted ? 'cancelled' : 'end_turn' }
				},
			},
		})
		await handshake(fixture)
		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: 'ses_acp_fixed', prompt: 'first' },
		})
		await settle()
		fixture.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/prompt',
			params: { sessionId: 'ses_acp_fixed', prompt: 'second' },
		})
		await settle()

		expect(fixture.sent.find((m) => m.id === 4)?.error?.code).toBe(ACP_ERROR_CODES.INVALID_REQUEST)
		expect(signals).toHaveLength(1)
		fixture.deliver({
			jsonrpc: '2.0',
			id: 5,
			method: 'session/cancel',
			params: { sessionId: 'ses_acp_fixed' },
		})
		await settle()
		expect(signals[0]?.aborted).toBe(true)
		release.resolve()
		await settle()
		expect(fixture.sent.find((m) => m.id === 3)?.result).toEqual({ stopReason: 'cancelled' })
	})
})

describe('session/cancel', () => {
	it('aborts the signal the running prompt was given', async () => {
		let seen: AbortSignal | undefined
		const fixture = build({
			gateway: {
				prompt: async ({ signal }) => {
					seen = signal
					await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
					return { stopReason: 'cancelled' }
				},
			},
		})
		await handshake(fixture)

		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: 'ses_acp_fixed', prompt: 'long one' },
		})
		await settle()
		expect(seen?.aborted).toBe(false)

		fixture.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/cancel',
			params: { sessionId: 'ses_acp_fixed' },
		})
		await settle()

		expect(seen?.aborted).toBe(true)
		expect(fixture.sent.find((m) => m.id === 3)?.result).toEqual({ stopReason: 'cancelled' })
	})

	it('gives a second turn a fresh signal rather than the aborted one', async () => {
		const signals: AbortSignal[] = []
		const fixture = build({
			gateway: {
				prompt: async ({ signal }) => {
					signals.push(signal)
					return { stopReason: 'end_turn' }
				},
			},
		})
		await handshake(fixture)

		const prompt = (id: number) =>
			fixture.deliver({
				jsonrpc: '2.0',
				id,
				method: 'session/prompt',
				params: { sessionId: 'ses_acp_fixed', prompt: 'x' },
			})

		prompt(3)
		await settle()
		fixture.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/cancel',
			params: { sessionId: 'ses_acp_fixed' },
		})
		await settle()
		prompt(5)
		await settle()

		// Reusing the controller would start the second turn already cancelled,
		// which reads to a client as a prompt that was ignored.
		expect(signals).toHaveLength(2)
		expect(signals[1]?.aborted).toBe(false)
	})

	it('reports cancellation when an abort makes the gateway reject instead of return', async () => {
		const fixture = build({
			gateway: {
				prompt: async ({ signal }) =>
					new Promise((_resolve, reject) => {
						signal.addEventListener('abort', () => reject(new Error('transport aborted')))
					}),
			},
		})
		await handshake(fixture)
		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: 'ses_acp_fixed', prompt: 'hold' },
		})
		await settle()
		fixture.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/cancel',
			params: { sessionId: 'ses_acp_fixed' },
		})
		await settle()

		expect(fixture.sent.find((frame) => frame.id === 3)?.result).toEqual({
			stopReason: 'cancelled',
		})
	})
})

describe('this module never compares a tool name', () => {
	it('has no tool-name comparison anywhere in the acp bridge', () => {
		const here = dirname(fileURLToPath(import.meta.url))
		const sources = ['server.ts', 'update.ts', 'index.ts'].map((f) =>
			readFileSync(join(here, '..', f), 'utf8'),
		)

		for (const source of sources) {
			// Strip comments first: the reason this rule exists is written in
			// them, and the prose naming `'edit'` must not be what fails the
			// check that the CODE does not.
			const code = source
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.split('\n')
				.filter((line) => !line.trim().startsWith('//'))
				.join('\n')

			// A front end that switched on a tool name could never give a diff to
			// a tool it had not heard of. `createToolPresenter` asks the tool.
			expect(code).not.toMatch(/toolName\s*===/)
			expect(code).not.toMatch(/===\s*['"](edit|write|read|bash)['"]/)
		}
	})

	it('sends an edit as a diff, because the tool said so', async () => {
		const registry = new ToolRegistry()
		registry.register({
			name: 'edit',
			description: 'edits a file',
			inputSchema: { type: 'object' },
			category: 'filesystem',
			permissions: [],
			readOnly: false,
			destructive: true,
			concurrencySafe: false,
			execute: async () => ({ success: true, output: 'done' }),
			presentCall: (input: unknown) => ({
				kind: 'diff' as const,
				path: (input as { path: string }).path,
				before: (input as { before: string }).before,
				after: (input as { after: string }).after,
			}),
		} as never)

		const wire = pair()
		const server = new ACPServer({
			transport: wire.transport,
			gateway: {
				prompt: async ({ onEvent }) => {
					onEvent({
						type: 'tool_executing',
						runId: fixtureId.run('acp'),
						toolUseId: 'toolu_1',
						toolName: 'edit',
						input: { path: 'a.txt', before: 'one', after: 'two' },
					} as RunEvent)
					return { stopReason: 'end_turn' }
				},
			},
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(registry),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
			newSessionId: () => 'ses_acp_fixed',
		})
		const fixture = { ...wire, server }
		await handshake(fixture)

		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: 'ses_acp_fixed', prompt: 'edit it' },
		})
		await settle()

		const update = fixture.sent.find((m) => m.method === 'session/update')?.params as {
			update: { kind: string; view: { kind: string; path?: string } }
		}
		expect(update.update.kind).toBe('tool_call')
		expect(update.update.view.kind).toBe('diff')
		expect(update.update.view.path).toBe('a.txt')
	})
})

describe('a transport that fails', () => {
	it('does not let a send error escape into a handler', async () => {
		const wire = pair()
		const server = new ACPServer({
			transport: {
				...wire.transport,
				send: async () => {
					throw new Error('client hung up')
				},
			},
			gateway: { prompt: async () => ({ stopReason: 'end_turn' }) },
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
		})
		await server.start()

		// The peer went away mid-write. There is nothing to recover, and a
		// throw here would surface as an unhandled rejection in whichever
		// handler happened to be running.
		const rejections: unknown[] = []
		const onRejection = (err: unknown) => rejections.push(err)
		process.on('unhandledRejection', onRejection)
		wire.deliver({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
		await settle()
		await settle()
		process.off('unhandledRejection', onRejection)

		expect(rejections).toEqual([])
	})
})

describe('stop reasons', () => {
	it('maps an unrecognised one to error rather than forwarding it', async () => {
		const fixture = build({
			gateway: { prompt: async () => ({ stopReason: 'something_new' }) },
		})
		await handshake(fixture)

		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: 'ses_acp_fixed', prompt: 'x' },
		})
		await settle()

		// A peer receiving a word its own union does not contain cannot render
		// it. Saying "error" is more useful than inventing a case for it.
		expect(fixture.sent.find((m) => m.id === 3)?.result).toEqual({ stopReason: 'error' })
	})
})

describe('frames that are not calls', () => {
	it('ignores a RESPONSE frame rather than answering it', async () => {
		const fixture = build()
		await fixture.server.start()

		// A frame with an `id` and no `method` is the client answering
		// something. Answering it back would put a frame on the wire nobody
		// asked for, and a naive dispatcher treats it as an unknown method.
		fixture.deliver({ jsonrpc: '2.0', id: 99, result: { ok: true } })
		await settle()

		expect(fixture.sent).toHaveLength(0)
	})
})

describe('a wire write failure', () => {
	it('survives a non-Error transport rejection and answers the next call', async () => {
		const sent: MCPJsonRpcMessage[] = []
		let handler: ((message: MCPJsonRpcMessage) => void) | undefined
		let fail = true
		const transport: MCPTransport = {
			connect: async () => {},
			close: async () => {},
			send: async (message) => {
				if (fail) throw 'pipe closed'
				sent.push(message)
			},
			onMessage: (next) => {
				handler = next
			},
			onClose: () => {},
			onError: () => {},
			isConnected: () => true,
		}
		const server = new ACPServer({
			transport,
			gateway: { prompt: async () => ({ stopReason: 'end_turn' }) },
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
		})
		await server.start()
		handler?.({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
		await settle()

		fail = false
		handler?.({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })
		await settle()

		expect(sent.find((frame) => frame.id === 2)?.result).toBeDefined()
	})
})

describe('a handler that throws something that is not a protocol error', () => {
	it('answers -32603 and keeps the connection open', async () => {
		const fixture = build({
			gateway: {
				prompt: async () => {
					throw new Error('the model is on fire')
				},
			},
		})
		await handshake(fixture)

		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: 'ses_acp_fixed', prompt: 'x' },
		})
		await settle()

		const reply = fixture.sent.find((m) => m.id === 3)
		expect(reply?.error?.code).toBe(ACP_ERROR_CODES.INTERNAL_ERROR)
		// The reason reaches the client. A bare "internal error" would send an
		// editor's user to a log file they cannot see.
		expect(reply?.error?.message).toContain('the model is on fire')

		fixture.deliver({ jsonrpc: '2.0', id: 4, method: 'initialize', params: {} })
		await settle()
		expect(fixture.sent.find((m) => m.id === 4)?.result).toBeDefined()
	})

	it('reports a thrown non-Error without losing it', async () => {
		const fixture = build({
			gateway: {
				prompt: async () => {
					throw 'a string, which is legal to throw and easy to drop'
				},
			},
		})
		await handshake(fixture)

		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: 'ses_acp_fixed', prompt: 'x' },
		})
		await settle()

		expect(fixture.sent.find((m) => m.id === 3)?.error?.message).toContain('a string')
	})
})

describe('stop()', () => {
	it('aborts a session that is still running', async () => {
		let seen: AbortSignal | undefined
		const fixture = build({
			gateway: {
				prompt: async ({ signal }) => {
					seen = signal
					await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
					return { stopReason: 'cancelled' }
				},
			},
		})
		await handshake(fixture)
		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: 'ses_acp_fixed', prompt: 'x' },
		})
		await settle()

		await fixture.server.stop()

		// The client hung up with work in flight. Leaving the turn running
		// would keep a model call — and whatever it spends — alive with nobody
		// left to receive the answer.
		expect(seen?.aborted).toBe(true)
	})

	it('cannot restart, admit a late frame, or publish a load that settles after close', async () => {
		const loadRelease = deferred<void>()
		const wire = pair()
		const server = new ACPServer({
			transport: wire.transport,
			gateway: {
				load: async () => {
					await loadRelease.promise
					return []
				},
				prompt: async () => ({ stopReason: 'end_turn' }),
			},
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
		})
		await server.start()
		wire.deliver({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { capabilities: [ACP_PERMISSION_CAPABILITY] },
		})
		await settle()
		wire.deliver({
			jsonrpc: '2.0',
			id: 2,
			method: 'session/load',
			params: { sessionId: 'ses_late', cwd: process.cwd() },
		})
		await settle()

		await server.stop()
		await expect(server.start()).rejects.toThrow('cannot be restarted')
		wire.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/new',
			params: { cwd: process.cwd() },
		})
		await settle()
		expect(wire.sent.find((frame) => frame.id === 3)?.error?.message).toContain('closed')

		loadRelease.resolve()
		await settle()
		expect(wire.sent.find((frame) => frame.id === 2)?.error?.message).toContain('closed')
	})
})

describe('defaults', () => {
	it('mints its own session id when the host injects none', async () => {
		const wire = pair()
		const server = new ACPServer({
			transport: wire.transport,
			gateway: { prompt: async () => ({ stopReason: 'end_turn' }) },
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
		})
		await server.start()
		wire.deliver({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { capabilities: [ACP_PERMISSION_CAPABILITY] },
		})
		await settle()
		wire.deliver({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} })
		await settle()

		const id = (wire.sent.find((m) => m.id === 2)?.result as { sessionId: string }).sessionId
		expect(id).toMatch(/^acp_/)

		// And a second session does not collide with the first, which is the
		// only property a caller can rely on.
		wire.deliver({ jsonrpc: '2.0', id: 3, method: 'session/new', params: {} })
		await settle()
		const second = (wire.sent.find((m) => m.id === 3)?.result as { sessionId: string }).sessionId
		expect(second).not.toBe(id)
	})

	it('gives the prompt the cwd the client named', async () => {
		let seen: string | undefined
		const fixture = build({
			gateway: {
				prompt: async ({ cwd }) => {
					seen = cwd
					return { stopReason: 'end_turn' }
				},
			},
		})
		await fixture.server.start()
		fixture.deliver({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { capabilities: [ACP_PERMISSION_CAPABILITY] },
		})
		await settle()
		fixture.deliver({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/work/here' } })
		await settle()
		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: 'ses_acp_fixed', prompt: 'x' },
		})
		await settle()

		// The client picked the directory; an agent that silently worked in its
		// own would edit files nobody was looking at.
		expect(seen).toBe('/work/here')
	})
})

describe('session/cancel for a session that does not exist', () => {
	it('is refused rather than silently accepted', async () => {
		const fixture = build()
		await handshake(fixture)

		fixture.deliver({
			jsonrpc: '2.0',
			id: 5,
			method: 'session/cancel',
			params: { sessionId: 'ses_never_made' },
		})
		await settle()

		// Accepting it would tell a client its cancel landed when nothing was
		// cancelled — the shape of every "why is it still running" report.
		expect(fixture.sent.find((m) => m.id === 5)?.error?.code).toBe(ACP_ERROR_CODES.INVALID_PARAMS)
	})
})

describe('the session-id namespace', () => {
	it('refuses a loaded history that is not an array and releases its reservation', async () => {
		let valid = false
		const wire = pair()
		const server = new ACPServer({
			transport: wire.transport,
			gateway: {
				load: async () =>
					valid ? [] : ({ role: 'user', content: 'not an array' } as unknown as readonly unknown[]),
				prompt: async () => ({ stopReason: 'end_turn' }),
			},
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
		})
		await server.start()
		wire.deliver({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { capabilities: [ACP_PERMISSION_CAPABILITY] },
		})
		await settle()
		wire.deliver({
			jsonrpc: '2.0',
			id: 2,
			method: 'session/load',
			params: { sessionId: 'ses_invalid_history', cwd: process.cwd() },
		})
		await settle()
		expect(wire.sent.find((frame) => frame.id === 2)?.error).toMatchObject({
			code: ACP_ERROR_CODES.INTERNAL_ERROR,
			message: expect.stringContaining('invalid history'),
		})

		valid = true
		wire.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/load',
			params: { sessionId: 'ses_invalid_history', cwd: process.cwd() },
		})
		await settle()
		expect(wire.sent.find((frame) => frame.id === 3)?.result).toEqual({
			sessionId: 'ses_invalid_history',
		})
	})

	it('keeps a loaded live session while default generation skips its reserved id', async () => {
		const loadRelease = deferred<void>()
		let loadedSignal: AbortSignal | undefined
		const wire = pair()
		const server = new ACPServer({
			transport: wire.transport,
			gateway: {
				load: async () => {
					await loadRelease.promise
					return [{ role: 'user', content: 'durable turn' }]
				},
				prompt: async ({ sessionId, signal, history }) => {
					if (sessionId === 'acp_1') {
						loadedSignal = signal
						expect(history).toEqual([{ role: 'user', content: 'durable turn' }])
						await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
						return { stopReason: 'cancelled' }
					}
					return { stopReason: 'end_turn' }
				},
			},
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
		})
		await server.start()
		wire.deliver({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { capabilities: [ACP_PERMISSION_CAPABILITY] },
		})
		await settle()

		// Reserve `acp_1` before the store's first await settles.
		wire.deliver({
			jsonrpc: '2.0',
			id: 2,
			method: 'session/load',
			params: { sessionId: 'acp_1', cwd: process.cwd() },
		})
		await settle()
		wire.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/new',
			params: { cwd: process.cwd() },
		})
		await settle()
		expect(wire.sent.find((m) => m.id === 3)?.result).toEqual({ sessionId: 'acp_2' })

		loadRelease.resolve()
		await settle()
		expect(wire.sent.find((m) => m.id === 2)?.result).toEqual({ sessionId: 'acp_1' })

		wire.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/prompt',
			params: { sessionId: 'acp_1', prompt: 'hold' },
		})
		await settle()
		wire.deliver({
			jsonrpc: '2.0',
			id: 5,
			method: 'session/prompt',
			params: { sessionId: 'acp_2', prompt: 'independent' },
		})
		await settle()
		expect(wire.sent.find((m) => m.id === 5)?.result).toEqual({ stopReason: 'end_turn' })

		wire.deliver({
			jsonrpc: '2.0',
			id: 6,
			method: 'session/cancel',
			params: { sessionId: 'acp_1' },
		})
		await settle()
		expect(loadedSignal?.aborted).toBe(true)
		expect(wire.sent.find((m) => m.id === 4)?.result).toEqual({ stopReason: 'cancelled' })
	})

	it('admits only one concurrent load for the same absent id', async () => {
		const loadRelease = deferred<void>()
		let loadCalls = 0
		const wire = pair()
		const server = new ACPServer({
			transport: wire.transport,
			gateway: {
				load: async () => {
					loadCalls += 1
					await loadRelease.promise
					return []
				},
				prompt: async () => ({ stopReason: 'end_turn' }),
			},
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
		})
		await server.start()
		wire.deliver({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { capabilities: [ACP_PERMISSION_CAPABILITY] },
		})
		await settle()

		for (const id of [2, 3]) {
			wire.deliver({
				jsonrpc: '2.0',
				id,
				method: 'session/load',
				params: { sessionId: 'ses_same', cwd: process.cwd() },
			})
		}
		await settle()
		expect(loadCalls).toBe(1)
		expect(wire.sent.find((m) => m.id === 3)?.error?.code).toBe(ACP_ERROR_CODES.INVALID_PARAMS)

		loadRelease.resolve()
		await settle()
		expect(wire.sent.find((m) => m.id === 2)?.result).toEqual({ sessionId: 'ses_same' })
	})

	it('releases only its own reservation after a failed load so the id can be retried', async () => {
		let attempts = 0
		const wire = pair()
		const server = new ACPServer({
			transport: wire.transport,
			gateway: {
				load: async () => {
					attempts += 1
					if (attempts === 1) throw new Error('temporary store failure')
					return []
				},
				prompt: async () => ({ stopReason: 'end_turn' }),
			},
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolRegistry()),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
		})
		await server.start()
		wire.deliver({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { capabilities: [ACP_PERMISSION_CAPABILITY] },
		})
		await settle()

		for (const id of [2, 3]) {
			wire.deliver({
				jsonrpc: '2.0',
				id,
				method: 'session/load',
				params: { sessionId: 'ses_retry', cwd: process.cwd() },
			})
			await settle()
		}

		expect(wire.sent.find((m) => m.id === 2)?.error?.message).toContain('temporary store failure')
		expect(wire.sent.find((m) => m.id === 3)?.result).toEqual({ sessionId: 'ses_retry' })
		expect(attempts).toBe(2)
	})
})
