/**
 * A server that finishes connecting after the session closed is closed, not
 * mounted. The client and discovery are faked so the order of events is decided
 * by the test, not by how fast a child process starts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => {
	const state = {
		disconnects: 0,
		toolsetCloses: 0,
		discoveryStarted: undefined as (() => void) | undefined,
		releaseDiscovery: undefined as (() => void) | undefined,
	}
	return state
})

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	class FakeClient {
		async connect(): Promise<void> {}
		async disconnect(): Promise<void> {
			fake.disconnects++
		}
		getState() {
			return { status: 'connected' as const }
		}
	}
	return {
		...actual,
		MCPClient: FakeClient,
		mcpToolset: async () => {
			fake.discoveryStarted?.()
			await new Promise<void>((resolve) => {
				fake.releaseDiscovery = resolve
			})
			return [
				{
					tools: () => [{ name: 'mcp__tickets__create' }],
					close: async () => {
						fake.toolsetCloses++
					},
				},
			]
		},
	}
})

import { startMcpServers } from '../servers.js'

beforeEach(() => {
	fake.disconnects = 0
	fake.toolsetCloses = 0
	fake.releaseDiscovery = undefined
})

describe('a server that answers after the session closed', () => {
	it('is closed and its tools are not mounted', async () => {
		const discoveryStarted = new Promise<void>((resolve) => {
			fake.discoveryStarted = resolve
		})
		const connection = startMcpServers(
			{ tickets: { command: 'unused', args: [] } },
			{ cwd: process.cwd() },
		)
		await discoveryStarted
		await connection.close()
		const disconnectsAtClose = fake.disconnects
		fake.releaseDiscovery?.()
		await connection.ready

		expect(fake.toolsetCloses).toBe(1)
		expect(fake.disconnects).toBeGreaterThan(disconnectsAtClose)
		expect(connection.current().connected).toEqual([])
		expect(connection.pending).toEqual([])
		expect(connection.tools).toEqual([])
	})
})
