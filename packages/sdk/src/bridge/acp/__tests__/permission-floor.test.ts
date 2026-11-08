import { describe, expect, it } from 'vitest'

import { ACP_CLIENT_REQUESTS, ACP_PERMISSION_CAPABILITY } from '../../../constants/acp/index.js'
import { HostCommandRegistry } from '../../../registry/command/index.js'
import { createToolPresenter } from '../../../registry/tool/presentation.js'
import { mustAskPerson } from '../../../runtime/query/review-policy.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { MCPJsonRpcMessage, MCPTransport } from '../../../types/connector/mcp.js'
import type { AcpPermissionOutcome, AcpPermissionRequest } from '../permission.js'
import { ACPServer } from '../server.js'

/**
 * A client's "approve all" is a latch on the session, and the latch answers
 * ordinary asks. A call marked `alwaysAsk` exists to put a question to a person,
 * so it is still sent to the client, and an `approve_all` given to it is one yes.
 */

type Call = AcpPermissionRequest['toolCalls'][number]
const ordinary: Call = { id: 'o', name: 'deploy', input: {}, isDestructive: false }
const marked: Call = { ...ordinary, id: 'm', alwaysAsk: true }

function pair() {
	const sent: MCPJsonRpcMessage[] = []
	let handler: ((m: MCPJsonRpcMessage) => void) | undefined
	const transport: MCPTransport = {
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
	}
	return { sent, transport, deliver: (m: MCPJsonRpcMessage) => handler?.(m) }
}

/**
 * A session whose gateway asks once per entry of `batches`, in order, and a
 * client that answers each wire request from `answers` in order. Resolves with
 * what the client was sent and what each ask returned; the prompt response
 * arrives when the last ask has returned, so nothing here waits on a clock.
 */
async function run(batches: readonly Call[][], answers: readonly unknown[]) {
	const wire = pair()
	const received: { toolCalls: readonly Call[] }[] = []
	const outcomes: AcpPermissionOutcome[] = []
	let next = 0
	let seen = 0
	const respond = () => {
		for (; seen < wire.sent.length; seen++) {
			const frame = wire.sent[seen]
			if (frame?.method !== ACP_CLIENT_REQUESTS.REQUEST_PERMISSION || frame.id === undefined)
				continue
			received.push(frame.params as { toolCalls: readonly Call[] })
			wire.deliver({ jsonrpc: '2.0', id: frame.id, result: answers[next++] })
		}
	}
	const original = wire.transport.send.bind(wire.transport)
	wire.transport.send = async (m) => {
		await original(m)
		queueMicrotask(respond)
	}
	const server = new ACPServer({
		transport: wire.transport,
		gateway: {
			prompt: async ({ ask, sessionId }) => {
				for (const toolCalls of batches) outcomes.push(await ask({ sessionId, toolCalls }))
				return { stopReason: 'end_turn' }
			},
		},
		commands: new HostCommandRegistry(),
		presenter: createToolPresenter(new ToolManager({ toolsets: [], messages: () => [] })),
		agentInfo: { name: 'namzu', version: '0.0.0-test' },
		newSessionId: () => 'ses_floor',
	})
	await server.start()
	const reply = (id: number) =>
		new Promise<void>((resolve) => {
			const check = wire.transport.send
			wire.transport.send = async (m) => {
				await check(m)
				if (m.id === id) resolve()
			}
		})
	wire.deliver({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: { capabilities: [ACP_PERMISSION_CAPABILITY] },
	})
	await new Promise((r) => setImmediate(r))
	wire.deliver({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} })
	await new Promise((r) => setImmediate(r))
	const done = reply(3)
	wire.deliver({
		jsonrpc: '2.0',
		id: 3,
		method: 'session/prompt',
		params: { sessionId: 'ses_floor', prompt: 'go' },
	})
	await done
	return { received, outcomes }
}

const all = { outcome: 'approve_all' }

describe('the approve_all latch and the calls that always ask', () => {
	it('still answers an ordinary ask once latched', async () => {
		const { received, outcomes } = await run([[ordinary], [ordinary]], [all])
		expect(received).toHaveLength(1)
		expect(outcomes.map((o) => o.kind)).toEqual(['approve_all', 'approve_all'])
	})

	it('sends a request holding a marked call to the client even when latched', async () => {
		const { received, outcomes } = await run([[ordinary], [marked]], [all, { outcome: 'approve' }])
		expect(received).toHaveLength(2)
		expect(received[1]?.toolCalls[0]?.alwaysAsk).toBe(true)
		expect(outcomes.map((o) => o.kind)).toEqual(['approve_all', 'approve'])
	})

	it('asks for a mixed batch, since one marked call is enough', async () => {
		const { received } = await run([[ordinary], [ordinary, marked]], [all, { outcome: 'approve' }])
		expect(received).toHaveLength(2)
	})

	it('treats an approve_all given to a marked request as one yes and leaves the latch as it was', async () => {
		const { received, outcomes } = await run([[marked], [ordinary], [ordinary]], [all, all])
		// The marked ask was approved once; the next ordinary ask had to go to the
		// client (no latch yet), and its approve_all then latched the third.
		expect(received).toHaveLength(2)
		expect(outcomes.map((o) => o.kind)).toEqual(['approve', 'approve_all', 'approve_all'])
	})

	it('honours a reject on a marked request', async () => {
		const { outcomes } = await run(
			[[ordinary], [marked]],
			[all, { outcome: 'reject', feedback: 'no' }],
		)
		expect(outcomes[1]).toMatchObject({ kind: 'reject', feedback: 'no' })
	})

	it('treats an older gateway that sends no field as ordinary calls', async () => {
		const { received } = await run([[ordinary], [{ ...ordinary, id: 'x' }]], [all])
		expect(received).toHaveLength(1)
	})
})

describe('mustAskPerson', () => {
	it.each([
		['an escalation of any kind', { escalation: { somethingNew: true } }],
		['a tool that needs approval every time', { requiresApproval: true }],
		['a rule that asked', { authorization: { askRule: true } }],
		['a rule that requested review', { authorization: { explicitReview: true } }],
		['a hook that asked', { hookPermission: { decision: 'ask' } }],
	])('marks %s', (_label, call) => {
		expect(mustAskPerson(call)).toBe(true)
	})

	it('leaves an ordinary call, and a hook that allowed, unmarked', () => {
		expect(mustAskPerson({})).toBe(false)
		expect(mustAskPerson({ hookPermission: { decision: 'allow' } })).toBe(false)
	})
})
