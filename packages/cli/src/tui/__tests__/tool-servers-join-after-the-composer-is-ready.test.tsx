/**
 * Tool servers connect in the background: the composer is ready before any of
 * them has answered, and each server is reported in plain words when it
 * connects or fails. The session here settles its servers only when the test
 * says so, so no outcome depends on how long anything takes.
 */

import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

const servers = vi.hoisted(() => ({
	asked: [] as Array<string | undefined>,
	connected: [] as Array<{ name: string; toolCount: number; tools: string[] }>,
	failed: [] as Array<{ name: string; reason: string }>,
	pending: ['docs', 'tickets'] as string[],
	listeners: new Set<(name: string) => void>(),
}))

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: PREFS,
			needsRepickReason: null,
			credentialGap: null,
			detected: [],
		}),
		createAgentSession: async (
			_prefs: unknown,
			_detected: unknown,
			options: { toolServers?: 'wait' | 'background' },
		) => {
			servers.asked.push(options.toolServers)
			return fakeAgentSession({
				get mcpConnected() {
					return servers.connected
				},
				get mcpFailed() {
					return servers.failed
				},
				mcpStatus: () => ({
					connected: servers.connected,
					failed: servers.failed,
					pending: servers.pending,
				}),
				onMcpSettled: (listener) => {
					servers.listeners.add(listener)
					return () => servers.listeners.delete(listener)
				},
			})
		},
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
let mounted: ReturnType<typeof render> | undefined

afterEach(() => {
	mounted?.unmount()
	mounted = undefined
	servers.asked = []
	servers.connected = []
	servers.failed = []
	servers.pending = ['docs', 'tickets']
	servers.listeners.clear()
})

const shown = () => (mounted?.frames ?? []).join('\n')
async function waitFor(text: string): Promise<void> {
	await vi.waitFor(() => expect(shown()).toContain(text))
}

it('is ready to type in before a tool server has answered, and reports each one as it settles', async () => {
	mounted = render(<App ctx={ctx} />)
	await waitFor('❯ Type a message')
	// The session was opened without waiting for the servers, and none has answered.
	expect(servers.asked).toEqual(['background'])
	expect(shown()).not.toContain('Tool server')

	servers.pending = ['docs']
	servers.connected = [{ name: 'tickets', toolCount: 1, tools: ['mcp__tickets__create'] }]
	for (const listener of servers.listeners) listener('tickets')
	await waitFor('Tool server tickets · 1 tool')
	expect(shown()).not.toContain('1 tools')

	servers.pending = []
	servers.failed = [{ name: 'docs', reason: 'server "docs" did not answer within 10000ms' }]
	for (const listener of servers.listeners) listener('docs')
	await waitFor('Tool server docs is not available. It did not answer in time.')
	expect(shown()).not.toMatch(/10000ms/)
})

it('says in /mcp which servers are still connecting', async () => {
	mounted = render(<App ctx={ctx} />)
	await waitFor('❯ Type a message')
	mounted.stdin.write('/mcp')
	await waitFor('/mcp')
	mounted.stdin.write('\r')
	await waitFor('2 connecting')
	expect(shown()).toContain('docs: connecting')
})
