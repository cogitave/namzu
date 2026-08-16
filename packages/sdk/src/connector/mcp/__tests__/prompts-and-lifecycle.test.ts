import { describe, expect, it, vi } from 'vitest'

import { JSON_RPC_METHOD_NOT_FOUND } from '../../../constants/mcp/index.js'
import type {
	MCPJsonRpcMessage,
	MCPPromptDefinition,
	MCPPromptMessage,
	MCPTransport,
} from '../../../types/connector/index.js'
import { MCPClient } from '../client.js'
import { MCPServer } from '../server/server.js'
import type { MCPServerPromptProvider, MCPServerToolProvider } from '../server/server.js'

/**
 * The half of MCP that is not tools.
 *
 * `MCPPromptDefinition` and `MCPPromptArgument` were declared when the types
 * were written; no client method ever asked for a prompt and no server branch
 * ever served one. `MCPLifecycleEvent` and `MCPEventListener` were declared
 * beside them and nothing ever emitted one, so a host could learn that a
 * server had died only by noticing calls had started failing.
 */

function fakeTransport(): {
	transport: MCPTransport
	sent: MCPJsonRpcMessage[]
	deliver: (m: MCPJsonRpcMessage) => void
} {
	const sent: MCPJsonRpcMessage[] = []
	let onMessage: ((m: MCPJsonRpcMessage) => void) | undefined
	const transport: MCPTransport = {
		connect: async () => undefined,
		close: async () => undefined,
		send: async (m: MCPJsonRpcMessage) => {
			sent.push(m)
		},
		onMessage: (h: (m: MCPJsonRpcMessage) => void) => {
			onMessage = h
		},
		onClose: () => undefined,
		onError: () => undefined,
	} as unknown as MCPTransport
	return { transport, sent, deliver: (m) => onMessage?.(m) }
}

const toolProvider: MCPServerToolProvider = {
	listTools: () => [],
	callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
}

function promptProvider(over: Partial<MCPServerPromptProvider> = {}): MCPServerPromptProvider {
	const prompts: MCPPromptDefinition[] = [
		{
			name: 'summarize',
			description: 'Summarize a file',
			arguments: [
				{ name: 'path', required: true },
				{ name: 'style', required: false },
			],
		},
	]
	const messages: MCPPromptMessage[] = [
		{ role: 'user', content: { type: 'text', text: 'summarize it' } },
	]
	return {
		listPrompts: () => prompts,
		getPrompt: async () => ({ description: 'Summarize a file', messages }),
		...over,
	}
}

async function ask(
	t: ReturnType<typeof fakeTransport>,
	method: string,
	params: Record<string, unknown> = {},
) {
	t.deliver({ jsonrpc: '2.0', id: 1, method, params } as MCPJsonRpcMessage)
	await new Promise((r) => setTimeout(r, 0))
	return t.sent.at(-1) as MCPJsonRpcMessage & {
		result?: unknown
		error?: { code: number; message: string }
	}
}

describe('a server serves the prompts it publishes', () => {
	it('lists them', async () => {
		const t = fakeTransport()
		const server = new MCPServer({ name: 'srv' }, toolProvider, undefined, promptProvider())
		await server.start(t.transport)

		const reply = await ask(t, 'prompts/list')

		expect((reply.result as { prompts: MCPPromptDefinition[] }).prompts[0]?.name).toBe('summarize')
	})

	it('returns the messages the server composed', async () => {
		const t = fakeTransport()
		const server = new MCPServer({ name: 'srv' }, toolProvider, undefined, promptProvider())
		await server.start(t.transport)

		const reply = await ask(t, 'prompts/get', {
			name: 'summarize',
			arguments: { path: 'a.ts' },
		})

		expect((reply.result as { messages: MCPPromptMessage[] }).messages[0]?.content).toEqual({
			type: 'text',
			text: 'summarize it',
		})
	})

	it('advertises the capability only when something is behind it', async () => {
		const withPrompts = fakeTransport()
		const without = fakeTransport()
		const a = new MCPServer({ name: 'a' }, toolProvider, undefined, promptProvider())
		const b = new MCPServer({ name: 'b' }, toolProvider)
		await a.start(withPrompts.transport)
		await b.start(without.transport)

		const withCap = await ask(withPrompts, 'initialize')
		const withoutCap = await ask(without, 'initialize')

		// A capability advertised without a provider is a promise the next
		// call breaks.
		expect(
			(withCap.result as { capabilities: Record<string, unknown> }).capabilities.prompts,
		).toBeDefined()
		expect(
			(withoutCap.result as { capabilities: Record<string, unknown> }).capabilities.prompts,
		).toBeUndefined()
	})

	it('refuses a required argument the caller omitted', async () => {
		const t = fakeTransport()
		const server = new MCPServer({ name: 'srv' }, toolProvider, undefined, promptProvider())
		await server.start(t.transport)

		const reply = await ask(t, 'prompts/get', { name: 'summarize', arguments: {} })

		// Checked from the declaration, so every provider does not have to
		// re-implement it or forget to.
		expect(reply.error?.message).toContain('path')
	})

	it('accepts an optional argument being absent', async () => {
		const t = fakeTransport()
		const server = new MCPServer({ name: 'srv' }, toolProvider, undefined, promptProvider())
		await server.start(t.transport)

		const reply = await ask(t, 'prompts/get', {
			name: 'summarize',
			arguments: { path: 'a.ts' },
		})

		expect(reply.error).toBeUndefined()
	})

	it('refuses a prompt it does not publish', async () => {
		const t = fakeTransport()
		const server = new MCPServer({ name: 'srv' }, toolProvider, undefined, promptProvider())
		await server.start(t.transport)

		const reply = await ask(t, 'prompts/get', { name: 'nonexistent' })

		expect(reply.error?.message).toContain('nonexistent')
	})
})

describe('"none" and "not here" are different answers', () => {
	it('says method-not-found for prompts when there is no provider', async () => {
		const t = fakeTransport()
		const server = new MCPServer({ name: 'srv' }, toolProvider)
		await server.start(t.transport)

		const reply = await ask(t, 'prompts/list')

		expect(reply.error?.code).toBe(JSON_RPC_METHOD_NOT_FOUND)
	})

	it('says method-not-found for resources when there is no provider', async () => {
		const t = fakeTransport()
		const server = new MCPServer({ name: 'srv' }, toolProvider)
		await server.start(t.transport)

		const reply = await ask(t, 'resources/list')

		// This used to answer `{ resources: [] }` for a capability
		// `initialize` never advertised — telling a client "none" where the
		// truth is "not here". The two send a client in opposite directions.
		expect(reply.error?.code).toBe(JSON_RPC_METHOD_NOT_FOUND)
	})

	it('uses the protocol code for an unknown method, not a generic failure', async () => {
		const t = fakeTransport()
		const server = new MCPServer({ name: 'srv' }, toolProvider)
		await server.start(t.transport)

		const reply = await ask(t, 'completely/unknown')

		expect(reply.error?.code).toBe(JSON_RPC_METHOD_NOT_FOUND)
	})

	it('still reports a provider failure as an internal error', async () => {
		const t = fakeTransport()
		const server = new MCPServer(
			{ name: 'srv' },
			toolProvider,
			undefined,
			promptProvider({
				listPrompts: () => {
					throw new Error('provider exploded')
				},
			}),
		)
		await server.start(t.transport)

		const reply = await ask(t, 'prompts/list')

		// A broken provider is not the same as an unimplemented method, and
		// collapsing the two would tell a client to stop asking for something
		// that works tomorrow.
		expect(reply.error?.code).toBe(-32603)
	})
})

describe('a client says out loud what it already knew', () => {
	function failingClient() {
		// `connect` failing is the simplest path that actually emits. A
		// never-connected client's `disconnect` returns early and emits
		// nothing — an easy way to write a test that proves nothing, which is
		// what the first version of these did.
		return new MCPClient({
			serverName: 'srv',
			transport: { type: 'stdio', command: 'definitely-not-a-real-binary-xyz', args: [] },
		})
	}

	/**
	 * Covered here: the transport-error emitter. `connect`'s own catch emits
	 * the same event and is NOT pinned — a spawn failure surfaces through the
	 * transport first, so the catch is the second line of defence rather than
	 * the path this reaches. Reaching it needs a connection that opens and
	 * then fails negotiation, which this fake cannot stage; said rather than
	 * left for a mutation run to discover.
	 */
	it('reports a failure to whoever is listening', async () => {
		const client = failingClient()
		const seen: string[] = []
		client.onLifecycle((e) => seen.push(e.type))

		await client.connect().catch(() => undefined)

		expect(seen).toContain('mcp_client_error')
	})

	it('stops reporting once the listener unsubscribes', async () => {
		const client = failingClient()
		const seen = vi.fn()

		const off = client.onLifecycle(seen)
		off()
		await client.connect().catch(() => undefined)

		// `onNotification` returns nothing, so a listener registered there
		// cannot be removed and keeps a disposed host object alive for as
		// long as the client. This is that bug not repeated.
		expect(seen).not.toHaveBeenCalled()
	})

	it('leaves other listeners working when one throws', async () => {
		const client = failingClient()
		const survivor = vi.fn()
		client.onLifecycle(() => {
			throw new Error('observer bug')
		})
		client.onLifecycle(survivor)

		await client.connect().catch(() => undefined)

		// These fire from inside transport callbacks and from `connect`'s
		// failure path, so an escaping exception would surface as a connection
		// error — blaming the server for a bug in the host's own observer, and
		// silencing every listener registered after the broken one.
		expect(survivor).toHaveBeenCalled()
	})
})
