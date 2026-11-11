/**
 * A server's progress-extension keys reach the SDK client, and a bad value is
 * refused by name. The client is the real one, subclassed only to record the
 * configuration it was built with; its command does not exist, so what is
 * checked is the configuration, not a connection.
 */

import { MCPClient, type MCPClientConfig } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

const built: MCPClientConfig[] = []

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	class RecordingClient extends actual.MCPClient {
		constructor(config: MCPClientConfig) {
			built.push(config)
			super(config)
		}
	}
	return { ...actual, MCPClient: RecordingClient }
})

import { connectMcpServers, progressDeadlineFor } from '../servers.js'

const spec = { command: '/nonexistent/namzu-test-server' }

afterEach(() => {
	built.length = 0
})

describe('progressDeadlineFor', () => {
	it('passes nothing through when nothing is set', () => {
		expect(progressDeadlineFor({ command: 'x' }, undefined)).toEqual({})
	})

	it('passes both keys through', () => {
		expect(
			progressDeadlineFor(
				{ command: 'x', resetTimeoutOnProgress: true, maxTotalTimeoutMs: 90_000 },
				30_000,
			),
		).toEqual({ resetTimeoutOnProgress: true, maxTotalTimeoutMs: 90_000 })
	})

	it.each([
		['a string flag', { resetTimeoutOnProgress: 'yes' }, 'resetTimeoutOnProgress'],
		['a zero cap', { maxTotalTimeoutMs: 0 }, 'maxTotalTimeoutMs'],
		['a negative cap', { maxTotalTimeoutMs: -1 }, 'maxTotalTimeoutMs'],
		['a fractional cap', { maxTotalTimeoutMs: 1.5 }, 'maxTotalTimeoutMs'],
		['a non-finite cap', { maxTotalTimeoutMs: Number.POSITIVE_INFINITY }, 'maxTotalTimeoutMs'],
		['a cap above the timer limit', { maxTotalTimeoutMs: 2_147_483_648 }, 'maxTotalTimeoutMs'],
	])('refuses %s by name', (_label, extra, key) => {
		const result = progressDeadlineFor({ command: 'x', ...extra } as never, 30_000)
		expect(typeof result).toBe('string')
		expect(result as string).toContain(key)
	})

	it('refuses a cap below the request deadline', () => {
		const result = progressDeadlineFor(
			{ command: 'x', requestTimeoutMs: 20_000, maxTotalTimeoutMs: 10_000 },
			20_000,
		)
		expect(result).toContain('must not be below requestTimeoutMs')
	})
})

describe('connectMcpServers and the progress deadline', () => {
	it('hands the keys to the client', async () => {
		const mcp = await connectMcpServers(
			{
				a: {
					...spec,
					requestTimeoutMs: 5_000,
					resetTimeoutOnProgress: true,
					maxTotalTimeoutMs: 60_000,
				},
			},
			{ cwd: process.cwd() },
		)
		await mcp.close()
		expect(built).toHaveLength(1)
		expect(built[0]).toMatchObject({
			requestTimeoutMs: 5_000,
			resetTimeoutOnProgress: true,
			maxTotalTimeoutMs: 60_000,
		})
		expect(MCPClient).toBeDefined()
	})

	it('leaves the client defaults alone when the keys are not set', async () => {
		const mcp = await connectMcpServers({ a: { ...spec } }, { cwd: process.cwd() })
		await mcp.close()
		expect(built[0]).not.toHaveProperty('resetTimeoutOnProgress')
		expect(built[0]).not.toHaveProperty('maxTotalTimeoutMs')
	})

	it('fails that server by name for a cap below its request deadline, and builds no client', async () => {
		const mcp = await connectMcpServers(
			{ a: { ...spec, requestTimeoutMs: 20_000, maxTotalTimeoutMs: 10_000 } },
			{ cwd: process.cwd() },
		)
		await mcp.close()
		expect(mcp.connected).toEqual([])
		expect(mcp.failed[0]?.name).toBe('a')
		expect(mcp.failed[0]?.reason).toContain('maxTotalTimeoutMs')
		expect(built).toHaveLength(0)
	})
})
