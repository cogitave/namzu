import { createServer, request as nodeRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EgressProxy } from '../proxy.js'
import type { RunningEgressProxy } from '../proxy.js'

/**
 * Until this existed, an egress policy could be declared and only two of
 * its four shapes could be honoured anywhere: the container backend
 * refused a host allowlist outright because it had no proxy to filter
 * through. `deny-all` and `allow-all` were the whole spectrum — all or
 * nothing.
 *
 * It also settles where credentials live. Any token the agent needed to
 * reach an allowed host had to be INSIDE the sandbox, in the environment,
 * readable by the untrusted code it is meant to be isolated from — via
 * `/proc/self/environ`, or via a prompt injection that exfiltrates it over
 * the very egress the policy permits.
 */

/** A stand-in upstream that reports what it was sent. */
function upstream(): Promise<{ server: Server; port: number; seen: IncomingMessage[] }> {
	const seen: IncomingMessage[] = []
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		seen.push(req)
		res.writeHead(200, { 'content-type': 'text/plain' })
		res.end('upstream ok')
	})
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			const port = typeof address === 'object' && address !== null ? address.port : 0
			resolve({ server, port, seen })
		})
	})
}

/**
 * Issue a request THROUGH the proxy, the way a proxied client does: the
 * absolute URL goes in the request line.
 *
 * `fetch` cannot express this — it owns the `Host` header and refuses an
 * override, so a request built with it names the proxy as its own target.
 * The first version of this helper did exactly that, and the proxy
 * forwarded to itself and hung. That hang is now a 400, and this helper
 * speaks the protocol properly.
 */
function viaProxy(
	proxy: RunningEgressProxy,
	target: string,
	init: { headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
	const proxyUrl = new URL(proxy.url)
	return new Promise((resolve, reject) => {
		const req = nodeRequest(
			{
				host: proxyUrl.hostname,
				port: Number(proxyUrl.port),
				method: 'GET',
				// Absolute-URI form: what distinguishes a proxied request.
				path: target,
				headers: init.headers ?? {},
			},
			(res) => {
				let body = ''
				res.setEncoding('utf-8')
				res.on('data', (chunk: string) => {
					body += chunk
				})
				res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
			},
		)
		req.on('error', reject)
		req.end()
	})
}

describe('the boundary', () => {
	let proxy: RunningEgressProxy
	let allowed: string[]
	let denied: Array<{ host: string; reason: string }>
	let target: Awaited<ReturnType<typeof upstream>>

	beforeEach(async () => {
		target = await upstream()
		allowed = ['127.0.0.1']
		denied = []
		proxy = await new EgressProxy({
			allowedHosts: async () => allowed,
			// The stand-in upstream speaks plain HTTP.
			upgradeToHttps: false,
			onDenied: (host, reason) => denied.push({ host, reason }),
		}).listen()
	})

	afterEach(async () => {
		await proxy.close()
		await new Promise<void>((resolve) => target.server.close(() => resolve()))
	})

	it('lets an allowed host through', async () => {
		const res = await viaProxy(proxy, `http://127.0.0.1:${target.port}/thing`)
		expect(res.status).toBe(200)
		expect(res.body).toBe('upstream ok')
	})

	it('refuses a host that is not on the list', async () => {
		allowed = ['example.com']
		const res = await viaProxy(proxy, `http://127.0.0.1:${target.port}/thing`)

		expect(res.status).toBe(403)
		// Never reached the upstream at all — the refusal is the point, not
		// the response code.
		expect(target.seen).toHaveLength(0)
	})

	it('names the host it refused', async () => {
		allowed = []
		const res = await viaProxy(proxy, `http://127.0.0.1:${target.port}/thing`)

		// An agent that cannot tell "not permitted" from "network down"
		// retries forever, and a human debugging it has nothing to go on.
		expect(res.body).toContain('127.0.0.1')
		expect(denied[0]?.host).toBe('127.0.0.1')
	})

	it('denies when the policy cannot be read', async () => {
		// An allowlist that fails open is not an allowlist.
		const failing = await new EgressProxy({
			allowedHosts: async () => {
				throw new Error('policy service unavailable')
			},
			upgradeToHttps: false,
		}).listen()

		try {
			const res = await viaProxy(failing, `http://127.0.0.1:${target.port}/thing`)
			expect(res.status).toBe(403)
		} finally {
			await failing.close()
		}
	})

	it('re-reads the policy per request, so a rotating allowlist is honoured', async () => {
		allowed = []
		expect((await viaProxy(proxy, `http://127.0.0.1:${target.port}/a`)).status).toBe(403)

		allowed = ['127.0.0.1']
		expect((await viaProxy(proxy, `http://127.0.0.1:${target.port}/b`)).status).toBe(200)
	})

	it('can be narrowed on a live proxy', async () => {
		// "Clone with a token, then drop to deny-all before running
		// untrusted build scripts" was not expressible at all: the policy
		// was frozen at provider construction.
		expect((await viaProxy(proxy, `http://127.0.0.1:${target.port}/a`)).status).toBe(200)

		proxy.setAllowedHosts(async () => [])
		expect((await viaProxy(proxy, `http://127.0.0.1:${target.port}/b`)).status).toBe(403)
	})
})

describe('brokering a credential', () => {
	let proxy: RunningEgressProxy
	let target: Awaited<ReturnType<typeof upstream>>

	beforeEach(async () => {
		target = await upstream()
	})

	afterEach(async () => {
		await proxy.close()
		await new Promise<void>((resolve) => target.server.close(() => resolve()))
	})

	const withCredentials = async (host: string) => {
		proxy = await new EgressProxy({
			allowedHosts: async () => ['127.0.0.1'],
			upgradeToHttps: false,
			credentials: [{ host, header: 'authorization', value: 'Bearer real-secret' }],
		}).listen()
		return proxy
	}

	it('stamps the real value on at the boundary', async () => {
		const p = await withCredentials('127.0.0.1')
		await viaProxy(p, `http://127.0.0.1:${target.port}/thing`)

		// The token never entered the sandbox — a placeholder did, and the
		// value was applied here.
		expect(target.seen[0]?.headers.authorization).toBe('Bearer real-secret')
	})

	it('sends it only to the host it belongs to', async () => {
		// A credential attached to every request is a credential handed to
		// whichever host the agent was talked into contacting.
		const p = await withCredentials('other.example.com')
		await viaProxy(p, `http://127.0.0.1:${target.port}/thing`)

		expect(target.seen[0]?.headers.authorization).toBeUndefined()
	})

	it('does not forward the hop-by-hop proxy header onward', async () => {
		const p = await withCredentials('127.0.0.1')
		await viaProxy(p, `http://127.0.0.1:${target.port}/thing`, {
			headers: { 'proxy-authorization': 'Basic should-not-travel' },
		})

		expect(target.seen[0]?.headers['proxy-authorization']).toBeUndefined()
	})
})
