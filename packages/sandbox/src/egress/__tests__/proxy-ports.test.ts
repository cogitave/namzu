import { createServer, request as nodeRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { type Server as NetServer, createServer as createNetServer } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { egressPortsForRules } from '../profile.js'
import { EgressProxy, type EgressProxyOptions, type RunningEgressProxy } from '../proxy.js'

/**
 * `EgressProxyOptions.allowedPorts`: the port check, on the port the socket is
 * about to open.
 *
 * Two paths dial a port the request does not necessarily name: a plain-HTTP
 * request with no port is dialled on 443 when it is upgraded to HTTPS, and a
 * `CONNECT host` with no port on 443. A check against the request's own port
 * would refuse `http://host/` under `ports: [443]`, or admit the wrong port;
 * these cases pin the dialled one. The rules come from `egressPortsForRules`,
 * the function the proxy container builds its check with, so the union rule
 * here is the profile's.
 */

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
			resolve({ server, port: typeof address === 'object' && address ? address.port : 0, seen })
		})
	})
}

function viaProxy(
	proxy: RunningEgressProxy,
	target: string,
): Promise<{ status: number; body: string }> {
	const proxyUrl = new URL(proxy.url)
	return new Promise((resolve, reject) => {
		const req = nodeRequest(
			{ host: proxyUrl.hostname, port: Number(proxyUrl.port), method: 'GET', path: target },
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

function connectVia(proxy: RunningEgressProxy, authority: string): Promise<string> {
	const proxyUrl = new URL(proxy.url)
	return new Promise((resolve) => {
		const req = nodeRequest({
			host: proxyUrl.hostname,
			port: Number(proxyUrl.port),
			method: 'CONNECT',
			path: authority,
		})
		req.on('connect', (res, socket, head) => {
			socket.destroy()
			resolve(`${res.statusCode} ${head.toString('utf-8')}`)
		})
		req.on('response', (res) => {
			let body = ''
			res.setEncoding('utf-8')
			res.on('data', (chunk: string) => {
				body += chunk
			})
			res.on('end', () => resolve(`${res.statusCode} ${body}`))
		})
		req.on('error', (err) => resolve(`no response (${err.message})`))
		req.end()
	})
}

/** Every `*.example.test` name resolves to loopback, which the tests exempt. */
const toLoopback: EgressProxyOptions['resolveAddresses'] = (_hostname, _options, callback) => {
	callback(null, [{ address: '127.0.0.1', family: 4 }])
}

describe('EgressProxy allowedPorts', () => {
	let target: Awaited<ReturnType<typeof upstream>>
	let tcp: NetServer
	let tcpPort: number
	const proxies: RunningEgressProxy[] = []
	let denied: Array<{ host: string; reason: string }>

	beforeEach(async () => {
		target = await upstream()
		denied = []
		tcp = createNetServer((socket) => socket.end())
		await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', () => resolve()))
		const address = tcp.address()
		tcpPort = typeof address === 'object' && address ? address.port : 0
	})

	afterEach(async () => {
		for (const proxy of proxies.splice(0)) await proxy.close()
		await new Promise<void>((resolve) => target.server.close(() => resolve()))
		await new Promise<void>((resolve) => tcp.close(() => resolve()))
	})

	async function proxyWith(options: Partial<EgressProxyOptions>): Promise<RunningEgressProxy> {
		const running = await new EgressProxy({
			allowedHosts: async () => ['127.0.0.1', '.example.test'],
			upgradeToHttps: false,
			allowInwardFor: ['127.0.0.1', '.example.test'],
			resolveAddresses: toLoopback,
			onDenied: (host, reason) => denied.push({ host, reason }),
			...options,
		}).listen()
		proxies.push(running)
		return running
	}

	it('admits an allowed port and refuses another, naming host and port', async () => {
		const allowedHere = await proxyWith({
			allowedPorts: egressPortsForRules([{ host: '127.0.0.1', ports: [target.port] }]),
		})
		expect((await viaProxy(allowedHere, `http://127.0.0.1:${target.port}/a`)).status).toBe(200)

		const refused = await proxyWith({
			allowedPorts: egressPortsForRules([{ host: '127.0.0.1', ports: [1] }]),
		})
		const res = await viaProxy(refused, `http://127.0.0.1:${target.port}/b`)
		expect(res.status).toBe(403)
		expect(res.body).toBe(`Egress denied: 127.0.0.1:${target.port} is not an allowed port.\n`)
		expect(target.seen).toHaveLength(1)
		expect(denied.at(-1)).toEqual({
			host: '127.0.0.1',
			reason: `port ${target.port} is not allowed`,
		})
	})

	it('refuses the port before any credential is looked up', async () => {
		let credentialRead = false
		const credential = {
			get host() {
				credentialRead = true
				return '127.0.0.1'
			},
			header: 'authorization',
			value: 'Bearer real-secret',
		}
		const proxy = await proxyWith({
			credentials: [credential],
			allowedPorts: egressPortsForRules([{ host: '127.0.0.1', ports: [1] }]),
		})
		expect((await viaProxy(proxy, `http://127.0.0.1:${target.port}/`)).status).toBe(403)
		expect(credentialRead).toBe(false)
	})

	it('checks an upgraded request on 443, the port it dials, not the port it names', async () => {
		// `http://api.example.test/` names no port; upgraded, it is dialled on
		// 443. Under `ports: [80]` that is refused, naming 443.
		const onlyEighty = await proxyWith({
			upgradeToHttps: true,
			allowedPorts: egressPortsForRules([{ host: 'api.example.test', ports: [80] }]),
		})
		const refused = await viaProxy(onlyEighty, 'http://api.example.test/')
		expect(refused.status).toBe(403)
		expect(refused.body).toBe('Egress denied: api.example.test:443 is not an allowed port.\n')

		// Under `ports: [443]` the port check passes; what happens next is the
		// upstream's business (nothing listens on loopback 443 here), and it is
		// not a port refusal.
		const onlyTls = await proxyWith({
			upgradeToHttps: true,
			allowedPorts: egressPortsForRules([{ host: 'api.example.test', ports: [443] }]),
		})
		const passed = await viaProxy(onlyTls, 'http://api.example.test/')
		expect(passed.body).not.toMatch(/is not an allowed port/)
	})

	it('checks a CONNECT on its port, and a portless CONNECT on 443', async () => {
		const proxy = await proxyWith({
			allowedPorts: egressPortsForRules([{ host: '127.0.0.1', ports: [tcpPort, 443] }]),
		})
		expect(await connectVia(proxy, '127.0.0.1:22')).toBe(
			'403 Egress denied: 127.0.0.1:22 is not an allowed port.\n',
		)
		expect(await connectVia(proxy, `127.0.0.1:${tcpPort}`)).toMatch(/^200 /)

		const noTls = await proxyWith({
			allowedPorts: egressPortsForRules([{ host: 'api.example.test', ports: [8443] }]),
		})
		expect(await connectVia(noTls, 'api.example.test')).toBe(
			'403 Egress denied: api.example.test:443 is not an allowed port.\n',
		)
	})

	it('gives a host the union of every rule that matches it', async () => {
		const proxy = await proxyWith({
			allowedPorts: egressPortsForRules([
				{ host: 'api.example.test', ports: [1] },
				{ host: '.example.test', ports: [target.port] },
			]),
		})
		// `api.example.test` gets 1 from its own rule and the upstream's port
		// from the domain rule.
		expect((await viaProxy(proxy, `http://api.example.test:${target.port}/`)).status).toBe(200)

		const narrow = await proxyWith({
			allowedPorts: egressPortsForRules([
				{ host: 'api.example.test', ports: [target.port] },
				{ host: '.example.test', ports: [1] },
			]),
		})
		// `www.example.test` matches only the domain rule.
		expect((await viaProxy(narrow, `http://www.example.test:${target.port}/`)).status).toBe(403)
	})

	it('denies when the port table cannot be read', async () => {
		const proxy = await proxyWith({
			allowedPorts: () => {
				throw new Error('table unavailable')
			},
		})
		expect((await viaProxy(proxy, `http://127.0.0.1:${target.port}/`)).status).toBe(403)
	})

	it('checks nothing when no table is given, as before', async () => {
		const proxy = await proxyWith({})
		expect((await viaProxy(proxy, `http://127.0.0.1:${target.port}/`)).status).toBe(200)
	})
})
