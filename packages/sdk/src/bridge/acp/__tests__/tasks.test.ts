import { expect, it } from 'vitest'
import { ACP_TASK_CAPABILITY } from '../../../constants/acp/index.js'
import { HostCommandRegistry } from '../../../registry/command/index.js'
import { createToolPresenter } from '../../../registry/tool/presentation.js'
import { fixtureId } from '../../../test-support/ids.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { MCPJsonRpcMessage, MCPTransport } from '../../../types/connector/mcp.js'
import type { SessionEvent } from '../../../types/session/events.js'
import { ACPServer, type AcpAgentGateway } from '../server.js'

const sessionId = fixtureId.session('acp-planning-session')
const turnId = fixtureId.turn('acp-planning-turn')
const taskId = fixtureId.task('acp-planning-task')
const blocker = fixtureId.task('acp-planning-blocker')
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
function task(
	overrides: Partial<Extract<SessionEvent, { type: 'task_created' }>> = {},
): SessionEvent {
	return {
		type: 'task_created',
		sessionId,
		turnId,
		taskId,
		subject: 'Inspect saved artifact',
		status: 'pending',
		...overrides,
	}
}
function harness(
	prompt: AcpAgentGateway['prompt'],
	supportsTaskNotifications?: boolean,
	onSend?: (message: MCPJsonRpcMessage) => Promise<void>,
) {
	let receive: ((message: MCPJsonRpcMessage) => void) | undefined
	const sent: MCPJsonRpcMessage[] = []
	const replies = new Map<number, (message: MCPJsonRpcMessage) => void>()
	const transport: MCPTransport = {
		connect: async () => {},
		close: async () => {},
		isConnected: () => true,
		onMessage: (handler) => {
			receive = handler
		},
		onClose: () => {},
		onError: () => {},
		send: async (message) => {
			await onSend?.(message)
			sent.push(message)
			if (message.method === 'session/request_permission')
				queueMicrotask(() =>
					receive?.({ jsonrpc: '2.0', id: message.id, result: { outcome: 'approve' } }),
				)
			if (typeof message.id === 'number' && message.method === undefined)
				replies.get(message.id)?.(message)
		},
	}
	const server = new ACPServer({
		transport,
		gateway: { prompt },
		supportsTaskNotifications,
		commands: new HostCommandRegistry(),
		presenter: createToolPresenter(new ToolManager({ toolsets: [], messages: () => [] })),
		agentInfo: { name: 'namzu', version: 'test' },
		newSessionId: () => sessionId,
	})
	let seq = 0
	const request = (method: string, params: Record<string, unknown> = {}) =>
		new Promise<MCPJsonRpcMessage>((resolve) => {
			const id = ++seq
			replies.set(id, (message) => {
				replies.delete(id)
				resolve(message)
			})
			receive?.({ jsonrpc: '2.0', id, method, params })
		})
	const start = async (clientSupports = true) => {
		await server.start()
		const initialized = await request('initialize', {
			capabilities: ['permission', ...(clientSupports ? [ACP_TASK_CAPABILITY] : [])],
		})
		await request('session/new')
		return initialized.result as { optionalClientCapabilities: string[] }
	}
	return { server, sent, request, start }
}

it.each([
	[undefined, false],
	[undefined, true],
	[true, false],
	[true, true],
] as const)(
	'negotiates planning notifications with host %s and client %s without widening core updates',
	async (host, client) => {
		const h = harness(async ({ onEvent }) => {
			onEvent(task())
			return { stopReason: 'end_turn' }
		}, host)
		try {
			const initialized = await h.start(client)
			expect(initialized.optionalClientCapabilities.includes(ACP_TASK_CAPABILITY)).toBe(
				host === true,
			)
			await h.request('session/prompt', { sessionId, prompt: 'Inspect artifact' })
			expect(h.sent.filter((message) => message.method === 'namzu/tasks/update')).toHaveLength(
				host && client ? 1 : 0,
			)
			expect(h.sent.filter((message) => message.method === 'session/update')).toHaveLength(0)
		} finally {
			await h.server.stop()
		}
	},
)

it('forwards exact planning IDs and full replacement rows, including clears and deletion, without private task fields or child sessions', async () => {
	const h = harness(async ({ onEvent }) => {
		onEvent(
			Object.assign(task({ owner: 'Researcher', blockedBy: [blocker] }), {
				description: 'PRIVATE description',
				metadata: { credential: 'PRIVATE metadata' },
				tenantId: 'PRIVATE tenant',
				path: '/PRIVATE/host',
			}),
		)
		onEvent(task({ sessionId: fixtureId.session('foreign-child') }))
		onEvent({
			type: 'task_updated',
			sessionId,
			turnId,
			taskId,
			subject: 'Inspect saved artifact',
			status: 'failed',
		})
		onEvent({
			type: 'task_updated',
			sessionId,
			turnId,
			taskId,
			subject: 'Inspect saved artifact',
			status: 'failed',
			deleted: true,
		})
		return { stopReason: 'end_turn' }
	}, true)
	try {
		await h.start()
		await h.request('session/prompt', { sessionId, prompt: 'Inspect artifact' })
		const updates = h.sent
			.filter((message) => message.method === 'namzu/tasks/update')
			.map((message) => message.params)
		expect(updates).toEqual([
			{
				sessionId,
				task: {
					taskId,
					subject: 'Inspect saved artifact',
					status: 'pending',
					owner: 'Researcher',
					blockedBy: [blocker],
				},
			},
			{
				sessionId,
				task: { taskId, subject: 'Inspect saved artifact', status: 'failed', blockedBy: [] },
			},
			{
				sessionId,
				task: { taskId, subject: 'Inspect saved artifact', status: 'failed', blockedBy: [] },
				deleted: true,
			},
		])
		expect(JSON.stringify(updates)).not.toContain('PRIVATE')
	} finally {
		await h.server.stop()
	}
})

it('settles planning delivery in stream order before permission and prompt completion', async () => {
	const delivery = deferred<void>()
	const admitted = deferred<void>()
	const h = harness(
		async ({ onEvent, ask }) => {
			onEvent(task())
			onEvent({
				type: 'text_delta',
				sessionId,
				turnId,
				iteration: 1,
				messageId: fixtureId.message('planning-progress'),
				text: 'Inspecting',
			})
			await ask({
				sessionId,
				toolCalls: [{ id: 'write', name: 'write', input: {}, isDestructive: false }],
			})
			onEvent({
				type: 'turn_paused',
				sessionId,
				turnId,
				reason: 'Review completed',
				checkpointId: fixtureId.checkpoint('planning-checkpoint'),
			})
			return { stopReason: 'end_turn' }
		},
		true,
		async (message) => {
			if (message.method === 'namzu/tasks/update') {
				admitted.resolve()
				await delivery.promise
			}
		},
	)
	try {
		await h.start()
		const prompt = h.request('session/prompt', { sessionId, prompt: 'Inspect artifact' })
		await admitted.promise
		expect(
			h.sent.some(
				(message) =>
					message.method === 'session/update' || message.method === 'session/request_permission',
			),
		).toBe(false)
		delivery.resolve()
		const result = await prompt
		expect(result.result).toEqual({ stopReason: 'cancelled', reason: 'paused' })
		expect(h.sent.slice(2).map((message) => message.method ?? 'response')).toEqual([
			'namzu/tasks/update',
			'session/update',
			'session/request_permission',
			'session/update',
			'response',
		])
	} finally {
		delivery.resolve()
		await h.server.stop()
	}
})

it('refuses review after failed planning delivery and releases the prompt slot without claiming delivery', async () => {
	let fail = true
	const h = harness(
		async ({ onEvent, ask }) => {
			onEvent(task())
			await ask({ sessionId, toolCalls: [] })
			return { stopReason: 'end_turn' }
		},
		true,
		async (message) => {
			if (message.method === 'namzu/tasks/update' && fail) {
				fail = false
				throw new Error('planning delivery refused')
			}
		},
	)
	try {
		await h.start()
		const first = await h.request('session/prompt', { sessionId, prompt: 'Inspect artifact' })
		expect(first.error?.message).toContain('planning delivery refused')
		expect(h.sent.some((message) => message.method === 'session/request_permission')).toBe(false)
		const second = await h.request('session/prompt', { sessionId, prompt: 'Continue inspection' })
		expect(second.result).toEqual({ stopReason: 'end_turn', reason: 'end_turn' })
	} finally {
		await h.server.stop()
	}
})
