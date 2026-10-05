import { describe, expect, it, vi } from 'vitest'
import { ACP_ERROR_CODES, ACP_PERMISSION_CAPABILITY } from '../../../constants/acp/index.js'
import { HostCommandRegistry } from '../../../registry/command/index.js'
import { createToolPresenter } from '../../../registry/tool/presentation.js'
import { fixtureId } from '../../../test-support/ids.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { MCPJsonRpcMessage, MCPTransport } from '../../../types/connector/mcp.js'
import { ACPServer, type AcpAgentGateway } from '../server.js'

const sessionId = fixtureId.session('retry-acp-session')
const turnId = fixtureId.turn('retry-acp-turn')
const checkpointId = fixtureId.checkpoint('retry-acp-checkpoint')
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
function fixture(gateway: AcpAgentGateway) {
	const sent: MCPJsonRpcMessage[] = []
	const pending = new Map<number, (message: MCPJsonRpcMessage) => void>()
	let handler: ((message: MCPJsonRpcMessage) => void) | undefined
	let seq = 0
	let beforeSend: ((message: MCPJsonRpcMessage) => Promise<void>) | undefined
	const transport: MCPTransport = {
		connect: async () => {},
		close: async () => {},
		isConnected: () => true,
		onMessage: (fn) => {
			handler = fn
		},
		onClose: () => {},
		onError: () => {},
		send: async (message) => {
			await beforeSend?.(message)
			sent.push(message)
			if (typeof message.id === 'number' && !message.method) pending.get(message.id)?.(message)
			if (message.method === 'session/request_permission')
				handler?.({
					jsonrpc: '2.0',
					id: message.id,
					result: { outcome: 'reject', feedback: 'Retain review' },
				})
		},
	}
	const server = new ACPServer({
		transport,
		gateway,
		commands: new HostCommandRegistry(),
		presenter: createToolPresenter(new ToolManager({ toolsets: [], messages: () => [] })),
		agentInfo: { name: 'namzu', version: 'test' },
		newSessionId: () => sessionId,
		supportsPromptOptions: true,
	})
	const rpc = (method: string, params: Record<string, unknown> = {}) => {
		const id = ++seq
		return new Promise<MCPJsonRpcMessage>((resolve) => {
			pending.set(id, resolve)
			handler?.({ jsonrpc: '2.0', id, method, params })
		})
	}
	const start = async (capabilities = [ACP_PERMISSION_CAPABILITY]) => {
		await server.start()
		await rpc('initialize', { capabilities })
		await rpc('session/new', { cwd: '/owned-project' })
	}
	return {
		server,
		rpc,
		start,
		sent,
		gateSend: (hook: typeof beforeSend) => {
			beforeSend = hook
		},
	}
}

describe('ACP explicit retry uses the original prompt owner', () => {
	it('does not synthesize a prompt and retains exact session, target, options and history', async () => {
		const prompt = vi.fn(async (_request: Parameters<AcpAgentGateway['prompt']>[0]) => ({
			stopReason: 'end_turn',
		}))
		const retry = vi.fn(async (request: Parameters<NonNullable<AcpAgentGateway['retry']>>[0]) => {
			request.onEvent({
				type: 'text_delta',
				sessionId,
				turnId,
				iteration: 1,
				messageId: fixtureId.message('retry-result'),
				text: 'Resumed original request',
			})
			return {
				stopReason: 'end_turn',
				history: [{ role: 'assistant', content: 'Retained result' }],
			}
		})
		const f = fixture({ prompt, retry })
		await f.start()
		try {
			expect(
				await f.server.retrySession(sessionId, turnId, checkpointId, {
					permissionMode: 'plan',
					effort: 'low',
				}),
			).toMatchObject({ stopReason: 'end_turn' })
			const request = retry.mock.calls[0]![0]
			expect(request).toMatchObject({
				sessionId,
				turnId,
				checkpointId,
				cwd: '/owned-project',
				options: { permissionMode: 'plan', effort: 'low' },
			})
			expect(request).not.toHaveProperty('prompt')
			expect(request).not.toHaveProperty('attachments')
			expect(f.sent.some((row) => row.method === 'session/update')).toBe(true)
			expect(prompt).not.toHaveBeenCalled()
			await f.rpc('session/prompt', { sessionId, prompt: 'Actual later prompt' })
			expect(prompt.mock.calls[0]?.[0]).toMatchObject({
				history: [{ role: 'assistant', content: 'Retained result' }],
			})
		} finally {
			await f.server.stop()
		}
	})
	it('orders updates before permission and completion and forwards review without implicit consent', async () => {
		const held = deferred<void>()
		const admitted = deferred<void>()
		let outcome: unknown
		const retry: NonNullable<AcpAgentGateway['retry']> = async (request) => {
			request.onEvent({
				type: 'text_delta',
				sessionId,
				turnId,
				iteration: 1,
				messageId: fixtureId.message('retry-review'),
				text: 'Before review',
			})
			outcome = await request.ask({
				sessionId: 'untrusted-relabel',
				toolCalls: [{ id: 'write', name: 'write', input: {}, isDestructive: true }],
			})
			return { stopReason: 'end_turn' }
		}
		const f = fixture({ prompt: async () => ({}), retry })
		await f.start()
		f.gateSend(async (message) => {
			if (message.method === 'session/update') {
				admitted.resolve()
				await held.promise
			}
		})
		try {
			const running = f.server.retrySession(sessionId, turnId, checkpointId)
			await admitted.promise
			expect(f.sent.some((row) => row.method === 'session/request_permission')).toBe(false)
			held.resolve()
			await running
			expect(outcome).toEqual({ kind: 'reject', feedback: 'Retain review' })
			const permission = f.sent.find((row) => row.method === 'session/request_permission')!
			expect(permission.params).toMatchObject({ sessionId })
			expect(f.sent.indexOf(permission)).toBeGreaterThan(
				f.sent.findIndex((row) => row.method === 'session/update'),
			)
		} finally {
			held.resolve()
			await f.server.stop()
		}
	})
	it('shares single-flight and session cancellation with ordinary prompts', async () => {
		const admitted = deferred<void>()
		const retry: NonNullable<AcpAgentGateway['retry']> = async ({ signal }) => {
			admitted.resolve()
			await new Promise<void>((resolve) =>
				signal.addEventListener('abort', () => resolve(), { once: true }),
			)
			return { stopReason: 'cancelled' }
		}
		const f = fixture({ prompt: async () => ({}), retry })
		await f.start()
		try {
			const running = f.server.retrySession(sessionId, turnId, checkpointId)
			await admitted.promise
			await expect(f.server.retrySession(sessionId, turnId, checkpointId)).rejects.toMatchObject({
				code: ACP_ERROR_CODES.INVALID_REQUEST,
			})
			expect(
				(await f.rpc('session/prompt', { sessionId, prompt: 'Do not consume this draft' })).error
					?.code,
			).toBe(ACP_ERROR_CODES.INVALID_REQUEST)
			await f.rpc('session/cancel', { sessionId })
			expect(await running).toMatchObject({ stopReason: 'cancelled' })
		} finally {
			await f.server.stop()
		}
	})
	it('refuses an unpublished session, invalid settings, missing gateway and stopped owner', async () => {
		const retry = vi.fn(async () => ({}))
		const f = fixture({ prompt: async () => ({}), retry })
		await f.start()
		await expect(
			f.server.retrySession('not-published', turnId, checkpointId),
		).rejects.toMatchObject({ code: ACP_ERROR_CODES.INVALID_PARAMS })
		await expect(f.server.retrySession(sessionId, '', checkpointId)).rejects.toMatchObject({
			code: ACP_ERROR_CODES.INVALID_PARAMS,
		})
		await expect(
			f.server.retrySession(sessionId, turnId, checkpointId, { permissionMode: 'bogus' } as never),
		).rejects.toMatchObject({ code: ACP_ERROR_CODES.INVALID_PARAMS })
		expect(retry).not.toHaveBeenCalled()
		await f.server.stop()
		await expect(f.server.retrySession(sessionId, turnId, checkpointId)).rejects.toThrow('stopped')
		const unsupported = fixture({ prompt: async () => ({}) })
		await unsupported.start()
		try {
			await expect(
				unsupported.server.retrySession(sessionId, turnId, checkpointId),
			).rejects.toMatchObject({ code: ACP_ERROR_CODES.INVALID_REQUEST })
		} finally {
			await unsupported.server.stop()
		}
	})
})
