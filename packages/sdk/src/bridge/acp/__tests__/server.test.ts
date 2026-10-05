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
import { createToolPresenter } from '../../../registry/tool/presentation.js'
import { fixtureId } from '../../../test-support/ids.js'
import { testToolset } from '../../../test-support/toolset.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { MCPJsonRpcMessage, MCPTransport } from '../../../types/connector/mcp.js'
import type { SessionEvent } from '../../../types/session/events.js'
import { TurnInProgressError } from '../../../types/session/turn.js'
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

const emptyPresenter = () =>
	createToolPresenter(new ToolManager({ toolsets: [], messages: () => [] }))

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
		supportsPromptAttachments?: boolean
		supportsPromptOptions?: boolean
	} = {},
) {
	const wire = pair()
	const gateway: AcpAgentGateway = {
		prompt: over.gateway?.prompt ?? (async () => ({ stopReason: 'end_turn' })),
	}
	const server = new ACPServer({
		supportsPromptAttachments: over.supportsPromptAttachments,
		supportsPromptOptions: over.supportsPromptOptions,
		transport: wire.transport,
		gateway,
		commands: over.commands ?? new HostCommandRegistry(),
		presenter: emptyPresenter(),
		agentInfo: { name: 'namzu', version: '0.0.0-test' },
		newSessionId: () => '7532c215-cbb2-46ec-9aaf-02bc9c60d6af',
	})
	return { ...wire, server }
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

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
		expect((reply?.result as { sessionId: string }).sessionId).toBe(
			'7532c215-cbb2-46ec-9aaf-02bc9c60d6af',
		)
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
		const SID = fixtureId.session('acp')
		const TID = fixtureId.turn('acp')
		const fixture = build({
			gateway: {
				prompt: async ({ onEvent }) => {
					onEvent({
						type: 'text_delta',
						sessionId: SID,
						turnId: TID,
						iteration: 0,
						messageId: fixtureId.message('a'),
						text: 'hello ',
					} as SessionEvent)
					onEvent({
						type: 'text_delta',
						sessionId: SID,
						turnId: TID,
						iteration: 0,
						messageId: fixtureId.message('a'),
						text: 'peer',
					} as SessionEvent)
					return { stopReason: 'end_turn' }
				},
			},
		})
		await handshake(fixture)

		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'hi' },
		})
		await settle()

		const chunks = fixture.sent
			.filter((m) => m.method === 'session/update')
			.map((m) => (m.params as { update: { text?: string } }).update.text)
		expect(chunks).toEqual(['hello ', 'peer'])
		expect(fixture.sent.find((m) => m.id === 3)?.result).toEqual({
			stopReason: 'end_turn',
			reason: 'end_turn',
		})
	})

	it.each([
		{ label: 'corrected', result: 'Reviewed answer.', reason: 'end_turn', coarse: 'end_turn' },
		{ label: 'blocked', result: '', reason: 'output_guardrail', coarse: 'refused' },
	])(
		'delivers the authoritative $label answer after public stream phases',
		async ({ result, reason, coarse }) => {
			const SID = fixtureId.session('wire-final')
			const TID = fixtureId.turn('wire-final')
			const MID = fixtureId.message('wire-final')
			const fixture = build({
				gateway: {
					prompt: async ({ onEvent }) => {
						onEvent({
							type: 'reasoning_started',
							sessionId: SID,
							turnId: TID,
							iteration: 0,
							messageId: MID,
							blockIndex: 0,
							reasoningType: 'redacted_thinking',
						})
						onEvent({
							type: 'reasoning_completed',
							sessionId: SID,
							turnId: TID,
							iteration: 0,
							messageId: MID,
							blockIndex: 0,
							signed: true,
						})
						onEvent({
							type: 'text_delta',
							sessionId: SID,
							turnId: TID,
							iteration: 0,
							messageId: MID,
							text: 'Raw preview.',
							textPart: { id: 'answer-part', phase: 'final_answer' },
						})
						onEvent({
							type: 'message_completed',
							sessionId: SID,
							turnId: TID,
							iteration: 0,
							messageId: MID,
							stopReason: 'end_turn',
							content: 'Raw preview.',
						})
						onEvent({
							type: 'turn_completed',
							sessionId: SID,
							turnId: TID,
							stopReason: reason,
							result,
						} as SessionEvent)
						return { stopReason: reason }
					},
				},
			})
			await handshake(fixture)
			fixture.deliver({
				jsonrpc: '2.0',
				id: 3,
				method: 'session/prompt',
				params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'hi' },
			})
			await settle()
			const updates = fixture.sent
				.filter((frame) => frame.method === 'session/update')
				.map((frame) => (frame.params as { update: unknown }).update)
			expect(updates).toEqual([
				{
					kind: 'agent_thought',
					status: 'pending',
					turnId: TID,
					messageId: MID,
					iteration: 0,
					blockId: `${MID}:0`,
				},
				{
					kind: 'agent_thought',
					status: 'completed',
					turnId: TID,
					messageId: MID,
					iteration: 0,
					blockId: `${MID}:0`,
				},
				{
					kind: 'agent_message_chunk',
					text: 'Raw preview.',
					turnId: TID,
					messageId: MID,
					iteration: 0,
					phase: 'final_answer',
					textPart: { id: 'answer-part', phase: 'final_answer' },
				},
				{
					kind: 'agent_message',
					status: 'completed',
					turnId: TID,
					messageId: MID,
					iteration: 0,
					stopReason: 'end_turn',
					content: 'Raw preview.',
				},
				{ kind: 'turn_ended', turnId: TID, stopReason: coarse, reason, result },
			])
			expect(fixture.sent.at(-1)).toMatchObject({ id: 3, result: { stopReason: coarse, reason } })
		},
	)

	it('preserves update order across deferred writes and does not return before final delivery', async () => {
		const entered = deferred<void>()
		const release = deferred<void>()
		const fixture = build({
			gateway: {
				prompt: async ({ onEvent }) => {
					const identity = {
						sessionId: fixtureId.session('ordered'),
						turnId: fixtureId.turn('ordered'),
						messageId: fixtureId.message('ordered'),
						iteration: 0,
					}
					onEvent({ type: 'text_delta', ...identity, text: 'first' })
					onEvent({ type: 'text_delta', ...identity, text: 'second' })
					onEvent({
						type: 'turn_completed',
						sessionId: identity.sessionId,
						turnId: identity.turnId,
						result: 'settled',
						stopReason: 'end_turn',
					} as SessionEvent)
					return { stopReason: 'end_turn' }
				},
			},
		})
		await handshake(fixture)
		const originalSend = fixture.transport.send
		let writes = 0
		fixture.transport.send = async (frame) => {
			if (frame.method === 'session/update') {
				writes += 1
				if (writes === 1) {
					entered.resolve()
					await release.promise
				}
			}
			await originalSend(frame)
		}
		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'ordered' },
		})
		await entered.promise
		expect(writes).toBe(1)
		expect(fixture.sent.find((frame) => frame.id === 3)).toBeUndefined()
		release.resolve()
		await settle()
		const updates = fixture.sent
			.filter((frame) => frame.method === 'session/update')
			.map((frame) => (frame.params as { update: { text?: string; result?: string } }).update)
		expect(updates.map((update) => update.text ?? update.result)).toEqual([
			'first',
			'second',
			'settled',
		])
		expect(fixture.sent.at(-1)?.id).toBe(3)
	})

	it('retains an actual parked-segment reason when the gateway returns a coarse error', async () => {
		const fixture = build({
			gateway: {
				prompt: async ({ onEvent }) => {
					onEvent({
						type: 'turn_paused',
						sessionId: fixtureId.session('parked'),
						turnId: fixtureId.turn('parked'),
						checkpointId: fixtureId.checkpoint('parked'),
						reason: 'awaiting_review',
					})
					return { stopReason: 'error' }
				},
			},
		})
		await handshake(fixture)
		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'review' },
		})
		await settle()
		expect(fixture.sent.at(-1)).toMatchObject({
			id: 3,
			result: { stopReason: 'cancelled', reason: 'paused' },
		})
	})

	it('delivers a checkpointed provider failure before its coarse paused prompt response', async () => {
		const message =
			'zen — could not reach the provider: model "space-bunny-free": request timed out'
		const fixture = build({
			gateway: {
				prompt: async ({ onEvent }) => {
					onEvent({
						type: 'turn_paused',
						sessionId: fixtureId.session('parked'),
						turnId: fixtureId.turn('parked'),
						checkpointId: fixtureId.checkpoint('parked'),
						reason: message,
						failure: { code: 'provider_error', message, retryable: true },
						providerError: { providerId: 'zen', kind: 'network', detail: 'request timed out' },
					})
					return { stopReason: 'error' }
				},
			},
		})
		await handshake(fixture)
		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'continue' },
		})
		await settle()
		expect(fixture.sent.slice(-2)).toMatchObject([
			{
				method: 'session/update',
				params: {
					update: { kind: 'turn_ended', stopReason: 'cancelled', reason: 'paused', error: message },
				},
			},
			{ id: 3, result: { stopReason: 'cancelled', reason: 'paused' } },
		])
	})

	it('refuses a prompt for a session that does not exist', async () => {
		const fixture = build()
		await handshake(fixture)

		fixture.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/prompt',
			params: { sessionId: '24042aec-7c4c-4e75-9ea6-4dda71cb28ce', prompt: 'hi' },
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
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'first' },
		})
		await settle()
		returned.push({ role: 'user', content: 'mutated after publication' })
		fixture.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/prompt',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'second' },
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
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'first' },
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
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'first' },
		})
		await settle()
		fixture.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/prompt',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'second' },
		})
		await settle()

		expect(fixture.sent.find((m) => m.id === 4)?.error?.code).toBe(ACP_ERROR_CODES.INVALID_REQUEST)
		expect(signals).toHaveLength(1)
		fixture.deliver({
			jsonrpc: '2.0',
			id: 5,
			method: 'session/cancel',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af' },
		})
		await settle()
		expect(signals[0]?.aborted).toBe(true)
		release.resolve()
		await settle()
		expect(fixture.sent.find((m) => m.id === 3)?.result).toEqual({
			stopReason: 'cancelled',
			reason: 'cancelled',
		})
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
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'long one' },
		})
		await settle()
		expect(seen?.aborted).toBe(false)

		fixture.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/cancel',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af' },
		})
		await settle()

		expect(seen?.aborted).toBe(true)
		expect(fixture.sent.find((m) => m.id === 3)?.result).toEqual({
			stopReason: 'cancelled',
			reason: 'cancelled',
		})
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
				params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'x' },
			})

		prompt(3)
		await settle()
		fixture.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/cancel',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af' },
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
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'hold' },
		})
		await settle()
		fixture.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/cancel',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af' },
		})
		await settle()

		expect(fixture.sent.find((frame) => frame.id === 3)?.result).toEqual({
			stopReason: 'cancelled',
			reason: 'cancelled',
		})
		// Preparation emitted no runtime events: the response still carries
		// cancellation, without manufacturing an answer or a reasoning block.
		expect(fixture.sent.filter((frame) => frame.method === 'session/update')).toEqual([])
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
		const registry = testToolset({
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
						sessionId: fixtureId.session('acp'),
						turnId: fixtureId.turn('acp'),
						toolUseId: 'toolu_1',
						toolName: 'edit',
						input: { path: 'a.txt', before: 'one', after: 'two' },
					} as SessionEvent)
					return { stopReason: 'end_turn' }
				},
			},
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolManager({ toolsets: [registry], messages: () => [] })),
			agentInfo: { name: 'namzu', version: '0.0.0-test' },
			newSessionId: () => '7532c215-cbb2-46ec-9aaf-02bc9c60d6af',
		})
		const fixture = { ...wire, server }
		await handshake(fixture)

		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'edit it' },
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
	it('catches failed updates during a parked gateway, retains the first error and releases the prompt slot', async () => {
		const gatewayRelease = deferred<void>()
		const failedWrite = deferred<void>()
		let prompts = 0
		const fixture = build({
			gateway: {
				prompt: async ({ onEvent }) => {
					prompts += 1
					if (prompts > 1) return { stopReason: 'end_turn' }
					const identity = {
						sessionId: fixtureId.session('failed-write'),
						turnId: fixtureId.turn('failed-write'),
						messageId: fixtureId.message('failed-write'),
						iteration: 0,
					}
					onEvent({ type: 'text_delta', ...identity, text: 'first' })
					onEvent({ type: 'text_delta', ...identity, text: 'second' })
					onEvent({ type: 'text_delta', ...identity, text: 'third' })
					await gatewayRelease.promise
					return { stopReason: 'end_turn' }
				},
			},
		})
		await handshake(fixture)
		const originalSend = fixture.transport.send
		fixture.transport.send = async (frame) => {
			if (frame.method === 'session/update') {
				const update = (frame.params as { update: { text?: string } }).update
				if (update.text === 'first') {
					failedWrite.resolve()
					throw new Error('first update rejected')
				}
				if (update.text === 'third') throw new Error('later update rejected')
			}
			await originalSend(frame)
		}
		const rejections: unknown[] = []
		const onRejection = (error: unknown) => rejections.push(error)
		process.on('unhandledRejection', onRejection)
		try {
			fixture.deliver({
				jsonrpc: '2.0',
				id: 3,
				method: 'session/prompt',
				params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'first' },
			})
			await failedWrite.promise
			await settle()
			expect(rejections).toEqual([])
			expect(fixture.sent.find((frame) => frame.id === 3)).toBeUndefined()
			expect(
				fixture.sent
					.filter((frame) => frame.method === 'session/update')
					.map((frame) => (frame.params as { update: { text?: string } }).update.text),
			).toEqual(['second'])
			gatewayRelease.resolve()
			await settle()
			expect(fixture.sent.find((frame) => frame.id === 3)?.error?.message).toBe(
				'first update rejected',
			)
			fixture.deliver({
				jsonrpc: '2.0',
				id: 4,
				method: 'session/prompt',
				params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'next' },
			})
			await settle()
			expect(prompts).toBe(2)
			expect(fixture.sent.find((frame) => frame.id === 4)?.result).toEqual({
				stopReason: 'end_turn',
				reason: 'end_turn',
			})
			expect(rejections).toEqual([])
		} finally {
			gatewayRelease.resolve()
			process.off('unhandledRejection', onRejection)
		}
	})

	it('sends a permission request only after already-admitted asynchronous updates', async () => {
		const entered = deferred<void>()
		const release = deferred<void>()
		let approved = false
		const fixture = build({
			gateway: {
				prompt: async ({ onEvent, ask, sessionId }) => {
					onEvent({
						type: 'reasoning_started',
						sessionId: fixtureId.session('before-review'),
						turnId: fixtureId.turn('before-review'),
						messageId: fixtureId.message('before-review'),
						iteration: 0,
						blockIndex: 0,
						reasoningType: 'redacted_thinking',
					})
					const outcome = await ask({
						sessionId,
						toolCalls: [
							{
								id: 'reviewed',
								name: 'write_file',
								input: { path: 'owned.txt' },
								isDestructive: false,
							},
						],
					})
					approved = outcome.kind === 'approve'
					return { stopReason: 'end_turn' }
				},
			},
		})
		await handshake(fixture)
		const originalSend = fixture.transport.send
		fixture.transport.send = async (frame) => {
			if (frame.method === 'session/update') {
				entered.resolve()
				await release.promise
			}
			await originalSend(frame)
		}
		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'review' },
		})
		await entered.promise
		expect(fixture.sent.some((frame) => frame.method === 'session/request_permission')).toBe(false)
		expect(approved).toBe(false)
		release.resolve()
		await settle()
		const question = fixture.sent.find((frame) => frame.method === 'session/request_permission')
		expect(question?.id).toBeDefined()
		expect(fixture.sent.findIndex((frame) => frame.method === 'session/update')).toBeLessThan(
			fixture.sent.findIndex((frame) => frame.method === 'session/request_permission'),
		)
		fixture.deliver({ jsonrpc: '2.0', id: question?.id, result: { outcome: 'approve' } })
		await settle()
		expect(approved).toBe(true)
		expect(fixture.sent.find((frame) => frame.id === 3)?.result).toEqual({
			stopReason: 'end_turn',
			reason: 'end_turn',
		})
	})

	it('does not request or assume approval after an admitted update fails', async () => {
		let approved = false
		const fixture = build({
			gateway: {
				prompt: async ({ onEvent, ask, sessionId }) => {
					onEvent({
						type: 'text_delta',
						sessionId: fixtureId.session('denied-review'),
						turnId: fixtureId.turn('denied-review'),
						messageId: fixtureId.message('denied-review'),
						iteration: 0,
						text: 'Checking permissions.',
					})
					const outcome = await ask({
						sessionId,
						toolCalls: [
							{
								id: 'denied',
								name: 'write_file',
								input: { path: 'owned.txt' },
								isDestructive: false,
							},
						],
					})
					approved = outcome.kind === 'approve'
					return { stopReason: 'end_turn' }
				},
			},
		})
		await handshake(fixture)
		const originalSend = fixture.transport.send
		fixture.transport.send = async (frame) => {
			if (frame.method === 'session/update') throw new Error('review context not delivered')
			await originalSend(frame)
		}
		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'review' },
		})
		await settle()
		expect(approved).toBe(false)
		expect(fixture.sent.some((frame) => frame.method === 'session/request_permission')).toBe(false)
		expect(fixture.sent.find((frame) => frame.id === 3)?.error?.message).toBe(
			'review context not delivered',
		)
	})

	it('settles a failed permission send and allows a later prompt instead of parking consent forever', async () => {
		let prompts = 0
		let approved = false
		const fixture = build({
			gateway: {
				prompt: async ({ ask, sessionId }) => {
					prompts += 1
					if (prompts > 1) return { stopReason: 'end_turn' }
					const outcome = await ask({
						sessionId,
						toolCalls: [
							{
								id: 'failed-question',
								name: 'write_file',
								input: { path: 'owned.txt' },
								isDestructive: false,
							},
						],
					})
					approved = outcome.kind === 'approve'
					return { stopReason: 'end_turn' }
				},
			},
		})
		await handshake(fixture)
		const originalSend = fixture.transport.send
		fixture.transport.send = async (frame) => {
			if (frame.method === 'session/request_permission')
				throw new Error('permission question not delivered')
			await originalSend(frame)
		}
		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'first' },
		})
		await settle()
		expect(approved).toBe(false)
		expect(fixture.sent.find((frame) => frame.id === 3)?.error?.message).toBe(
			'permission question not delivered',
		)
		fixture.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/prompt',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'next' },
		})
		await settle()
		expect(prompts).toBe(2)
		expect(fixture.sent.find((frame) => frame.id === 4)?.result).toEqual({
			stopReason: 'end_turn',
			reason: 'end_turn',
		})
	})

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
			presenter: emptyPresenter(),
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
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'x' },
		})
		await settle()

		// A peer receiving a word its own union does not contain cannot render
		// it. Saying "error" is more useful than inventing a case for it.
		expect(fixture.sent.find((m) => m.id === 3)?.result).toEqual({
			stopReason: 'error',
			reason: 'something_new',
		})
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
			presenter: emptyPresenter(),
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
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'x' },
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
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'x' },
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
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'x' },
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
			presenter: emptyPresenter(),
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
			params: { sessionId: 'd360ee57-87f9-46f4-86c4-4fa2893115cc', cwd: process.cwd() },
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
			presenter: emptyPresenter(),
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
		// A namzu session id (UUIDv7), so the gateway can open the session log
		// under the very id the client holds.
		expect(id).toMatch(UUID_V7)

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
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'x' },
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
			params: { sessionId: '24042aec-7c4c-4e75-9ea6-4dda71cb28ce' },
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
			presenter: emptyPresenter(),
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
			params: { sessionId: '90252eec-95b2-41c1-a7d7-8b02c6ffd139', cwd: process.cwd() },
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
			params: { sessionId: '90252eec-95b2-41c1-a7d7-8b02c6ffd139', cwd: process.cwd() },
		})
		await settle()
		expect(wire.sent.find((frame) => frame.id === 3)?.result).toEqual({
			sessionId: '90252eec-95b2-41c1-a7d7-8b02c6ffd139',
		})
	})

	it('keeps a loaded live session, under the client’s opaque id, beside a generated one', async () => {
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
					if (sessionId === 'client-session-1') {
						loadedSignal = signal
						expect(history).toEqual([{ role: 'user', content: 'durable turn' }])
						await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
						return { stopReason: 'cancelled' }
					}
					return { stopReason: 'end_turn' }
				},
			},
			commands: new HostCommandRegistry(),
			presenter: emptyPresenter(),
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

		// Reserve the client's id before the store's first await settles. It is
		// not a namzu id and does not have to be: the bridge treats it as opaque.
		wire.deliver({
			jsonrpc: '2.0',
			id: 2,
			method: 'session/load',
			params: { sessionId: 'client-session-1', cwd: process.cwd() },
		})
		await settle()
		wire.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/new',
			params: { cwd: process.cwd() },
		})
		await settle()
		const generated = (wire.sent.find((m) => m.id === 3)?.result as { sessionId: string }).sessionId
		expect(generated).toMatch(UUID_V7)

		loadRelease.resolve()
		await settle()
		expect(wire.sent.find((m) => m.id === 2)?.result).toEqual({ sessionId: 'client-session-1' })

		wire.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/prompt',
			params: { sessionId: 'client-session-1', prompt: 'hold' },
		})
		await settle()
		wire.deliver({
			jsonrpc: '2.0',
			id: 5,
			method: 'session/prompt',
			params: { sessionId: generated, prompt: 'independent' },
		})
		await settle()
		expect(wire.sent.find((m) => m.id === 5)?.result).toEqual({
			stopReason: 'end_turn',
			reason: 'end_turn',
		})

		wire.deliver({
			jsonrpc: '2.0',
			id: 6,
			method: 'session/cancel',
			params: { sessionId: 'client-session-1' },
		})
		await settle()
		expect(loadedSignal?.aborted).toBe(true)
		expect(wire.sent.find((m) => m.id === 4)?.result).toEqual({
			stopReason: 'cancelled',
			reason: 'cancelled',
		})
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
			presenter: emptyPresenter(),
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
				params: { sessionId: 'a1af9d58-dd30-48f3-8622-af5503176684', cwd: process.cwd() },
			})
		}
		await settle()
		expect(loadCalls).toBe(1)
		expect(wire.sent.find((m) => m.id === 3)?.error?.code).toBe(ACP_ERROR_CODES.INVALID_PARAMS)

		loadRelease.resolve()
		await settle()
		expect(wire.sent.find((m) => m.id === 2)?.result).toEqual({
			sessionId: 'a1af9d58-dd30-48f3-8622-af5503176684',
		})
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
			presenter: emptyPresenter(),
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
				params: { sessionId: '54968feb-b0db-4ca1-a3c6-7659d5302f75', cwd: process.cwd() },
			})
			await settle()
		}

		expect(wire.sent.find((m) => m.id === 2)?.error?.message).toContain('temporary store failure')
		expect(wire.sent.find((m) => m.id === 3)?.result).toEqual({
			sessionId: '54968feb-b0db-4ca1-a3c6-7659d5302f75',
		})
		expect(attempts).toBe(2)
	})
})

describe('one active turn per session, and sessions the store does not have', () => {
	it('answers a prompt the session log refused with INVALID_REQUEST naming the active turn', async () => {
		// Another process may hold a turn on the same session. The log refuses
		// the new turn, and the peer is told what is in the way rather than
		// receiving an internal error.
		const activeTurnId = fixtureId.turn('elsewhere')
		let calls = 0
		const fixture = build({
			gateway: {
				prompt: async ({ sessionId }) => {
					calls += 1
					throw new TurnInProgressError({
						sessionId: sessionId as never,
						activeTurnId,
						state: 'paused',
					})
				},
			},
		})
		await handshake(fixture)
		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'again' },
		})
		await settle()

		const error = fixture.sent.find((m) => m.id === 3)?.error
		expect(error?.code).toBe(ACP_ERROR_CODES.INVALID_REQUEST)
		expect(error?.message).toContain(activeTurnId)
		expect(error?.message).toContain('paused')

		// The refusal did not leave this connection's prompt slot taken: the
		// next prompt reaches the gateway again.
		fixture.deliver({
			jsonrpc: '2.0',
			id: 4,
			method: 'session/prompt',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'later' },
		})
		await settle()
		expect(calls).toBe(2)
	})

	it('refuses to load a session the store does not have, naming the id', async () => {
		const wire = pair()
		const server = new ACPServer({
			transport: wire.transport,
			gateway: {
				load: async () => undefined,
				prompt: async () => ({ stopReason: 'end_turn' }),
			},
			commands: new HostCommandRegistry(),
			presenter: emptyPresenter(),
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
			params: { sessionId: 'never-seen', cwd: process.cwd() },
		})
		await settle()

		expect(wire.sent.find((m) => m.id === 2)?.error).toMatchObject({
			code: ACP_ERROR_CODES.INVALID_PARAMS,
			message: expect.stringContaining('"never-seen"'),
		})
		// Refused, and the id is free again rather than stuck reserved.
		wire.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: 'never-seen', prompt: 'x' },
		})
		await settle()
		expect(wire.sent.find((m) => m.id === 3)?.error?.code).toBe(ACP_ERROR_CODES.INVALID_PARAMS)
	})
})

describe('inline prompt attachment admission', () => {
	it('advertises host support and carries the exact inline bytes to the gateway', async () => {
		let received: Parameters<AcpAgentGateway['prompt']>[0] | undefined
		const fixture = build({
			supportsPromptAttachments: true,
			gateway: {
				prompt: async (request) => {
					received = request
					return { stopReason: 'end_turn' }
				},
			},
		})
		await handshake(fixture)
		const attachment = {
			type: 'image' as const,
			data: Buffer.from('owned image bytes').toString('base64'),
			mediaType: 'image/png',
		}
		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: {
				sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af',
				prompt: 'Look at this',
				attachments: [attachment],
			},
		})
		await settle()
		expect(fixture.sent.find((frame) => frame.id === 1)?.result).toMatchObject({
			promptAttachments: true,
		})
		expect(received?.attachments).toEqual([attachment])
		expect(received?.prompt).toBe('Look at this')
		expect(fixture.sent.find((frame) => frame.id === 3)?.result).toEqual({
			stopReason: 'end_turn',
			reason: 'end_turn',
		})
		await fixture.server.stop()
	})
	it('refuses unsupported delivery and opaque store references before running a gateway', async () => {
		let calls = 0
		for (const supports of [false, true]) {
			const fixture = build({
				supportsPromptAttachments: supports,
				gateway: {
					prompt: async () => {
						calls += 1
						return { stopReason: 'end_turn' }
					},
				},
			})
			await handshake(fixture)
			fixture.deliver({
				jsonrpc: '2.0',
				id: 3,
				method: 'session/prompt',
				params: {
					sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af',
					prompt: 'Image',
					attachments: supports
						? [{ type: 'stored', ref: '/foreign/store', mediaType: 'image/png', kind: 'image' }]
						: [{ data: 'eA==', mediaType: 'image/png' }],
				},
			})
			await settle()
			expect(fixture.sent.find((frame) => frame.id === 3)?.error?.code).toBe(
				supports ? ACP_ERROR_CODES.INVALID_PARAMS : ACP_ERROR_CODES.INVALID_REQUEST,
			)
			await fixture.server.stop()
		}
		expect(calls).toBe(0)
	})
	it('refuses malformed base64 and aggregate payload overflow without consuming the session turn', async () => {
		let calls = 0
		const fixture = build({
			supportsPromptAttachments: true,
			gateway: {
				prompt: async () => {
					calls += 1
					return { stopReason: 'end_turn' }
				},
			},
		})
		await handshake(fixture)
		for (const [id, attachments] of [
			[3, [{ data: 'not-base64', mediaType: 'image/png' }]],
			[
				4,
				Array.from({ length: 2 }, () => ({
					data: Buffer.alloc(2 * 1024 * 1024).toString('base64'),
					mediaType: 'image/png',
				})),
			],
		] as const) {
			fixture.deliver({
				jsonrpc: '2.0',
				id,
				method: 'session/prompt',
				params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'Image', attachments },
			})
			await settle()
			expect(fixture.sent.find((frame) => frame.id === id)?.error?.code).toBe(
				ACP_ERROR_CODES.INVALID_PARAMS,
			)
		}
		fixture.deliver({
			jsonrpc: '2.0',
			id: 5,
			method: 'session/prompt',
			params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'Plain follow-up' },
		})
		await settle()
		expect(calls).toBe(1)
		await fixture.server.stop()
	})
})

describe('per-message prompt settings', () => {
	it('advertises opt-in support and forwards the exact settings for the turn', async () => {
		let received: Parameters<AcpAgentGateway['prompt']>[0] | undefined
		const fixture = build({
			supportsPromptOptions: true,
			gateway: {
				prompt: async (request) => {
					received = request
					return { stopReason: 'end_turn' }
				},
			},
		})
		await handshake(fixture)
		fixture.deliver({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: {
				sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af',
				prompt: 'Review this',
				options: { effort: 'high', permissionMode: 'strict' },
			},
		})
		await settle()
		expect(fixture.sent.find((frame) => frame.id === 1)?.result).toMatchObject({
			promptOptions: true,
		})
		expect(received?.options).toEqual({ effort: 'high', permissionMode: 'strict' })
		await fixture.server.stop()
	})
	it('rejects invalid or unsupported settings before the gateway and leaves the session usable', async () => {
		let calls = 0
		for (const supports of [false, true]) {
			const fixture = build({
				supportsPromptOptions: supports,
				gateway: {
					prompt: async () => {
						calls += 1
						return { stopReason: 'end_turn' }
					},
				},
			})
			await handshake(fixture)
			for (const [index, options] of [
				{ effort: 'unknown' },
				{ permissionMode: 'skip' },
				{ effort: 'high', credential: 'synthetic' },
				{ effort: ['high'] },
			].entries()) {
				fixture.deliver({
					jsonrpc: '2.0',
					id: 3 + index,
					method: 'session/prompt',
					params: {
						sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af',
						prompt: 'Invalid',
						options,
					},
				})
				await settle()
				expect(fixture.sent.find((frame) => frame.id === 3 + index)?.error?.code).toBe(
					supports ? ACP_ERROR_CODES.INVALID_PARAMS : ACP_ERROR_CODES.INVALID_REQUEST,
				)
			}
			fixture.deliver({
				jsonrpc: '2.0',
				id: 7,
				method: 'session/prompt',
				params: { sessionId: '7532c215-cbb2-46ec-9aaf-02bc9c60d6af', prompt: 'Plain follow-up' },
			})
			await settle()
			await fixture.server.stop()
		}
		expect(calls).toBe(2)
	})
})
