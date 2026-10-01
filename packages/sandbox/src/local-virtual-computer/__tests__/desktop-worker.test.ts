import { once } from 'node:events'
import type { Server } from 'node:http'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createDesktopServer } = require('../../../local-computer/desktop-worker.cjs') as {
	createDesktopServer(options: {
		token?: string
		run?: (binary: string, args: string[]) => Promise<Buffer>
		fetchBrowser?: () => Promise<boolean>
	}): Server
}
const TOKEN = 'test-worker-private-token-not-a-user-credential'
const servers: Server[] = []
const screenshot = Buffer.alloc(24)
screenshot.write('89504e470d0a1a0a', 0, 'hex')
screenshot.writeUInt32BE(1280, 16)
screenshot.writeUInt32BE(800, 20)

function guestRunner() {
	return vi.fn(async (binary: string, args: string[]) => {
		if (binary === 'maim') return screenshot
		if (args[0] === 'getdisplaygeometry') return Buffer.from('1280 800\n')
		if (args[0] === 'getmouselocation') return Buffer.from('X=4\nY=5\nSCREEN=0\n')
		return Buffer.alloc(0)
	})
}

async function listen(options: Parameters<typeof createDesktopServer>[0]) {
	const server = createDesktopServer(options)
	servers.push(server)
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('Test server did not bind')
	return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections()
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		)
	}
})

describe('authenticated guest desktop worker', () => {
	it('refuses startup without an allocation credential', () => {
		expect(() => createDesktopServer({ token: '' })).toThrow('per-allocation')
	})
	it('authenticates readiness, input, screenshots and unknown paths before any guest command', async () => {
		const run = guestRunner()
		const url = await listen({ token: TOKEN, run, fetchBrowser: async () => true })
		for (const route of ['/readyz', '/action', '/unknown']) {
			const response = await fetch(`${url}${route}`)
			expect(response.status).toBe(401)
			expect(await response.json()).toEqual({ error: 'unauthorized' })
		}
		expect(run).not.toHaveBeenCalled()
	})
	it('refuses requests from a browser origin, even with a credential', async () => {
		const run = guestRunner()
		const url = await listen({ token: TOKEN, run, fetchBrowser: async () => true })
		const response = await fetch(`${url}/readyz`, {
			headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://untrusted.example' },
		})
		expect(response.status).toBe(401)
		expect(run).not.toHaveBeenCalled()
	})
	it('requires the display, a matching PNG capture and a running browser before connected', async () => {
		const url = await listen({ token: TOKEN, run: guestRunner(), fetchBrowser: async () => true })
		const response = await fetch(`${url}/readyz`, { headers: { authorization: `Bearer ${TOKEN}` } })
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			protocol: 1,
			width: 1280,
			height: 800,
			browserReady: true,
		})
		expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
	})
	it('reports not ready when the browser is absent', async () => {
		const url = await listen({ token: TOKEN, run: guestRunner(), fetchBrowser: async () => false })
		expect(
			(await fetch(`${url}/readyz`, { headers: { authorization: `Bearer ${TOKEN}` } })).status,
		).toBe(503)
	})
	it('returns guest screenshot bytes and sends literal text through argv without a shell', async () => {
		const run = guestRunner()
		const url = await listen({ token: TOKEN, run, fetchBrowser: async () => true })
		const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
		const capture = await fetch(`${url}/action`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ type: 'screenshot' }),
		})
		expect(await capture.json()).toEqual({
			type: 'screenshot',
			data: screenshot.toString('base64'),
		})
		const text = "$(throw 'expanded') ; `printf secret`"
		const response = await fetch(`${url}/action`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ type: 'type_text', text }),
		})
		expect(await response.json()).toEqual({ type: 'ok' })
		expect(run).toHaveBeenCalledWith('xdotool', [
			'type',
			'--clearmodifiers',
			'--delay',
			'0',
			'--',
			text,
		])
	})
	it('refuses invalid points before delivering input', async () => {
		const run = guestRunner()
		const url = await listen({ token: TOKEN, run, fetchBrowser: async () => true })
		const response = await fetch(`${url}/action`, {
			method: 'POST',
			headers: { authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({ type: 'mouse_click', at: { x: -1, y: 5 }, button: 'left' }),
		})
		expect(response.status).toBe(400)
		expect(run.mock.calls.every((call) => call[1][0] === 'getdisplaygeometry')).toBe(true)
	})
	it('marks failed state-changing dispatch as an unknown outcome', async () => {
		const run = guestRunner()
		run.mockImplementation(async (_binary, args) => {
			if (args[0] === 'getdisplaygeometry') return Buffer.from('1280 800')
			throw new Error('Command may have acted')
		})
		const url = await listen({ token: TOKEN, run, fetchBrowser: async () => true })
		const response = await fetch(`${url}/action`, {
			method: 'POST',
			headers: { authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({ type: 'key', keys: 'CTRL+L' }),
		})
		expect(await response.json()).toEqual({ outcome: 'unknown' })
	})
})
