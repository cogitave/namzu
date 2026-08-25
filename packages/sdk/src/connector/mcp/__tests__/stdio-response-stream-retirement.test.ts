import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { MCPClient } from '../client.js'
import { MCPReconnectSupervisor } from '../reconnect.js'

const FIXTURE = fileURLToPath(
	new URL('../__fixtures__/closes-response-stream.mjs', import.meta.url),
)
const cleanupPids = new Set<number>()
const cleanupDirs = new Set<string>()

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function within<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`did not settle within ${timeoutMs}ms`)),
					timeoutMs,
				)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`)
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

afterEach(async () => {
	for (const pid of cleanupPids) {
		if (isAlive(pid)) process.kill(pid, 'SIGKILL')
	}
	cleanupPids.clear()
	for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true })
	cleanupDirs.clear()
})

describe('an MCP response channel is a transport lifetime boundary', () => {
	it('retires pending work immediately and still reaps a child that stays alive', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-mcp-response-close-'))
		cleanupDirs.add(dir)
		const marker = join(dir, 'events.log')
		const client = new MCPClient({
			serverName: 'response-closer',
			transport: {
				type: 'stdio',
				command: process.execPath,
				args: [FIXTURE, marker],
			},
			requestTimeoutMs: 30_000,
		})

		await client.connect()
		const started = (await readFile(marker, 'utf8')).match(/^pid:(\d+):1$/m)
		if (!started) throw new Error('fixture did not publish its pid')
		const pid = Number(started[1])
		cleanupPids.add(pid)

		await expect(within(client.listTools())).rejects.toThrow(/transport.*closed/i)
		expect(client.getState().status).toBe('disconnected')
		await expect(client.listTools()).rejects.toThrow(/not connected/i)
		const events = await readFile(marker, 'utf8')
		expect(events.match(/^tools\/list$/gm)).toHaveLength(1)

		// Protocol retirement must not lose process ownership. The fixture is
		// deliberately alive here; an already-disconnected client still has to
		// reap it during normal teardown.
		expect(isAlive(pid)).toBe(true)
		await client.disconnect()
		expect(isAlive(pid)).toBe(false)
		cleanupPids.delete(pid)
	})

	it('reaps the retired process before reconnecting a fresh generation', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-mcp-response-reconnect-'))
		cleanupDirs.add(dir)
		const marker = join(dir, 'events.log')
		const client = new MCPClient({
			serverName: 'recovering-response-channel',
			transport: {
				type: 'stdio',
				command: process.execPath,
				args: [FIXTURE, marker],
			},
			requestTimeoutMs: 30_000,
		})
		const supervisor = new MCPReconnectSupervisor(client, {
			initialDelayMs: 10,
			maxDelayMs: 20,
			maxAttempts: 2,
		})

		await client.connect()
		const first = (await readFile(marker, 'utf8')).match(/^pid:(\d+):1$/m)
		if (!first) throw new Error('first fixture did not publish its pid')
		const firstPid = Number(first[1])
		cleanupPids.add(firstPid)
		supervisor.start()

		await expect(within(client.listTools())).rejects.toThrow(/transport.*closed/i)
		await waitUntil(() => client.isConnected())
		await expect(client.listTools()).resolves.toEqual([
			expect.objectContaining({ name: 'restored' }),
		])

		const launched = await readFile(marker, 'utf8')
		const second = launched.match(/^pid:(\d+):2$/m)
		if (!second) throw new Error('replacement fixture did not publish its pid')
		const secondPid = Number(second[1])
		cleanupPids.add(secondPid)
		expect(isAlive(firstPid)).toBe(false)
		expect(isAlive(secondPid)).toBe(true)
		expect(launched.match(/^tools\/list$/gm)).toHaveLength(2)

		supervisor.stop()
		await client.disconnect()
		expect(isAlive(secondPid)).toBe(false)
		cleanupPids.delete(firstPid)
		cleanupPids.delete(secondPid)
	})
})
