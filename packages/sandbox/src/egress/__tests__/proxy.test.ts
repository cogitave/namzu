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

/**
 * Issue a request through the proxy WITHOUT an absolute URL.
 *
 * A client that forgot the absolute form still sends `Host`, and the proxy
 * honours it — which is what makes a plain `fetch` through `HTTP_PROXY` work.
 * It is also the path that hands an address over exactly as written, because
 * `splitAuthority` does not normalise the way `new URL` does.
 */
function viaHostHeader(
	proxy: RunningEgressProxy,
	authority: string,
	path: string,
): Promise<{ status: number; body: string }> {
	const proxyUrl = new URL(proxy.url)
	return new Promise((resolve, reject) => {
		const req = nodeRequest(
			{
				host: proxyUrl.hostname,
				port: Number(proxyUrl.port),
				method: 'GET',
				path,
				headers: { host: authority },
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

/**
 * Open a tunnel through the proxy and return whatever it answered with.
 *
 * The refusal on this path is written straight onto the socket rather than
 * through a `ServerResponse`, so it has to be read as bytes — a request
 * helper would see a failed CONNECT and tell us nothing about what was said.
 */
function connectVia(proxy: RunningEgressProxy, authority: string): Promise<string> {
	const proxyUrl = new URL(proxy.url)
	// Never rejects: every outcome, including a dead socket, comes back as a
	// string to be compared.
	return new Promise((resolve) => {
		const req = nodeRequest({
			host: proxyUrl.hostname,
			port: Number(proxyUrl.port),
			method: 'CONNECT',
			path: authority,
		})
		// Node raises `connect` for the response to a CONNECT whatever its
		// status, so the status has to be read off the response rather than
		// inferred from which event fired. Assuming otherwise reports every
		// refusal as an established tunnel.
		req.on('connect', (res, socket, head) => {
			socket.destroy()
			resolve(`${res.statusCode} ${head.toString('utf-8')}`)
		})
		// A refusal never becomes a tunnel, so it arrives here as a plain
		// response rather than through `connect`.
		req.on('response', (res) => {
			let body = ''
			res.setEncoding('utf-8')
			res.on('data', (chunk: string) => {
				body += chunk
			})
			res.on('end', () => resolve(`${res.statusCode} ${body}`))
		})
		// A tunnel that dies without answering is an OUTCOME, not a broken
		// test, so it comes back as a string to be compared like the others.
		// Rejecting here would report "socket hang up" where the reader wants
		// "expected a refusal and the socket just closed" — a thrown error and
		// a failed assertion look the same in a summary and are not the same
		// evidence.
		req.on('error', (err) => resolve(`no response (${err.message})`))
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
			// The upstream in these tests IS a loopback address, which the
			// address screen refuses by default and rightly so. Naming the
			// exemption here rather than weakening the screen keeps these
			// tests about what they are about; the screen itself is proved in
			// `address.test.ts` and in the reach tests below.
			allowInwardFor: ['127.0.0.1'],
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

/**
 * What the name actually reaches.
 *
 * The allowlist decides on a NAME. Where that name goes is decided by DNS,
 * which the caller may control — so an allowlisted name is not a permitted
 * destination until something has looked at the address.
 *
 * These are the end-to-end half; `address.test.ts` pins the screen itself.
 * The two are needed separately: a unit test on `blockedAddressReason` passes
 * whether or not the proxy ever calls it, and the defect being fixed here was
 * exactly that nothing did.
 */
describe('what the name actually reaches', () => {
	let target: Awaited<ReturnType<typeof upstream>>
	let denied: Array<{ host: string; reason: string }>

	beforeEach(async () => {
		target = await upstream()
		denied = []
	})

	afterEach(async () => {
		await new Promise<void>((resolve) => target.server.close(() => resolve()))
	})

	/** A proxy that allows `host`, brokers a token for it, and resolves as told. */
	const proxyFor = async (host: string, resolvesTo?: string) =>
		new EgressProxy({
			allowedHosts: async () => [host],
			upgradeToHttps: false,
			credentials: [{ host, header: 'authorization', value: 'Bearer real-secret' }],
			onDenied: (h, reason) => denied.push({ host: h, reason }),
			...(resolvesTo
				? {
						resolveAddresses: (_hostname, _options, callback) => {
							callback(null, [{ address: resolvesTo, family: 4 }])
						},
					}
				: {}),
		}).listen()

	it('refuses an allowed name that resolves inward, and the credential goes nowhere', async () => {
		// The defect, end to end. `friendly.example` is on the allowlist and
		// has a token brokered for it; its DNS answers with loopback. Without
		// the screen the proxy connects and stamps `Bearer real-secret` on the
		// way out, so the credential-brokering design becomes the delivery
		// mechanism for the credential.
		const proxy = await proxyFor('friendly.example', '127.0.0.1')
		try {
			const res = await viaProxy(proxy, `http://friendly.example:${target.port}/thing`)

			expect(res.status).toBe(403)
			expect(res.body).toContain('127.0.0.1')
			expect(denied[0]?.reason).toContain('loopback')
			// The whole point: nothing arrived, so the token was never sent.
			expect(target.seen).toHaveLength(0)
		} finally {
			await proxy.close()
		}
	})

	it('refuses an allowed name that resolves to the metadata address', async () => {
		const proxy = await proxyFor('friendly.example', '169.254.169.254')
		try {
			const res = await viaProxy(proxy, 'http://friendly.example/latest/meta-data/')
			expect(res.status).toBe(403)
			expect(denied[0]?.reason).toContain('link-local')
		} finally {
			await proxy.close()
		}
	})

	it('refuses an allowed host that is already an inward literal', async () => {
		// A literal is never resolved, so the screening resolver is never
		// called for it. This case is the reason there are two checks rather
		// than one, and it is the case a green suite hid: every existing test
		// here points at `127.0.0.1`, which is a literal.
		const proxy = await proxyFor('169.254.169.254')
		try {
			const res = await viaProxy(proxy, 'http://169.254.169.254/latest/meta-data/')
			expect(res.status).toBe(403)
			expect(res.body).toContain('link-local')
			expect(target.seen).toHaveLength(0)
		} finally {
			await proxy.close()
		}
	})

	it('refuses the bracketed IPv6 spelling a proxied client actually sends', async () => {
		// `new URL(...).hostname` returns `[::ffff:7f00:1]`, brackets included,
		// and that is what the request line carries.
		//
		// TWO layers stop this one, and which fires first was worth measuring
		// rather than assuming: Node does not read a bracketed string as an IP
		// literal either, so with the literal check disabled the host goes to
		// `dns.lookup` — the screening resolver — and is refused there. So the
		// bracket handling in `blockedLiteralReason` is a layer earlier, not a
		// hole closed. It is still worth having: the exported helper is asked
		// about this exact spelling by `parseTarget`, and answering `null` for
		// an address it plainly recognises is the kind of true-looking answer
		// the next caller builds on.
		const proxy = await proxyFor('[::ffff:7f00:1]')
		try {
			const res = await viaProxy(proxy, `http://[::ffff:127.0.0.1]:${target.port}/thing`)
			expect(res.status).toBe(403)
			expect(target.seen).toHaveLength(0)
		} finally {
			await proxy.close()
		}
	})

	it('refuses a v4 address written long in IPv6, which IS a literal to the socket', async () => {
		// The case the bracket one is not. `isIP('0:0:0:0:0:ffff:127.0.0.1')`
		// is 6, so the socket dials it without ever resolving and the
		// screening lookup is never consulted — the literal check is the only
		// thing between this request and the upstream. A screen that pattern-
		// matched `^::ffff:` on the text passed it, and it is the same
		// loopback address as `::ffff:127.0.0.1`.
		//
		// Sent through the `Host` header rather than the request line, because
		// that is the path that hands the long form over intact:
		// `splitAuthority` strips the brackets and does not normalise, where
		// `new URL` would compress it first.
		const long = '0:0:0:0:0:ffff:127.0.0.1'
		const proxy = await proxyFor(long)
		try {
			const res = await viaHostHeader(proxy, `[${long}]:${target.port}`, '/thing')
			expect(res.status).toBe(403)
			expect(res.body).toContain('loopback')
			// The reach that would otherwise have happened, and the token with
			// it: this address connects to the stand-in upstream.
			expect(target.seen).toHaveLength(0)
		} finally {
			await proxy.close()
		}
	})

	it('refuses an inward literal on the tunnel path too', async () => {
		// CONNECT carries no brokered credential, so what is lost here is
		// reach rather than a token — but an allowlisted name pointing inward
		// still turns the proxy into a route to the host's own network.
		const proxy = await proxyFor('169.254.169.254')
		try {
			const res = await connectVia(proxy, '169.254.169.254:443')
			expect(res).toContain('403')
			expect(denied[0]?.reason).toContain('link-local')
		} finally {
			await proxy.close()
		}
	})

	it('refuses an allowed name that resolves inward on the tunnel path too', async () => {
		// The tunnel gets its own case because it gets its own socket call:
		// removing the screening resolver from `netConnect` alone breaks
		// nothing the plain-HTTP cases can see, and "both paths pass a
		// `lookup`" is two facts, not one.
		const proxy = await proxyFor('friendly.example', '127.0.0.1')
		try {
			const res = await connectVia(proxy, `friendly.example:${target.port}`)
			expect(res).toContain('403')
			expect(denied[0]?.reason).toContain('loopback')
		} finally {
			await proxy.close()
		}
	})

	it('lets the named exemption through without widening anything else', async () => {
		// The escape hatch exists because an operator may genuinely proxy to
		// one service on a private network. It is per host: the neighbour on
		// the same policy gets nothing from it.
		const proxy = await new EgressProxy({
			allowedHosts: async () => ['inside.example', 'other.example'],
			upgradeToHttps: false,
			allowInwardFor: ['inside.example'],
			onDenied: (h, reason) => denied.push({ host: h, reason }),
			resolveAddresses: (_hostname, _options, callback) => {
				callback(null, [{ address: '127.0.0.1', family: 4 }])
			},
		}).listen()

		try {
			const allowed = await viaProxy(proxy, `http://inside.example:${target.port}/thing`)
			expect(allowed.status).toBe(200)

			const neighbour = await viaProxy(proxy, `http://other.example:${target.port}/thing`)
			expect(neighbour.status).toBe(403)
		} finally {
			await proxy.close()
		}
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
			// See the note in the reach suite: the stand-in upstream is itself
			// a loopback address. Exempting it keeps these tests about
			// credential scoping rather than about addresses.
			allowInwardFor: ['127.0.0.1'],
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
