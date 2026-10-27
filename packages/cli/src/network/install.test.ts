import { mkdtempSync, writeFileSync } from 'node:fs'
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http'
import { type AddressInfo, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { classifyProviderError, explainError } from '@namzu/sdk'
import { Agent, setGlobalDispatcher } from 'undici'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { type DispatcherLibrary, describeNetwork, installNetwork } from './install.js'
import { readNetworkSettings } from './settings.js'

/**
 * A real proxy and a real origin on loopback; the request goes through the
 * platform's `fetch`, which is what every provider and tool-server client uses.
 */

const servers: Server[] = []
const roots: string[] = []

async function listen(server: Server): Promise<number> {
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	return (server.address() as AddressInfo).port
}

beforeEach(() => {
	setGlobalDispatcher(new Agent())
})

afterEach(async () => {
	setGlobalDispatcher(new Agent())
	for (const server of servers.splice(0)) {
		server.closeAllConnections()
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
	for (const root of roots.splice(0)) removeTempDir(root)
})

const quiet = { report: () => {} }

describe('a proxy named in the environment carries the requests', () => {
	it('sends a request through the proxy, which is asked for the address it cannot be reached without', async () => {
		const origin = createServer((req, res) => res.end(`origin saw ${req.headers.host}`))
		const originPort = await listen(origin)
		const seen: string[] = []
		const proxy = createServer()
		proxy.on('connect', (req, client, head) => {
			seen.push(req.url ?? '')
			const upstream = connect(originPort, '127.0.0.1', () => {
				client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
				upstream.write(head)
				upstream.pipe(client)
				client.pipe(upstream)
			})
			upstream.on('error', () => client.destroy())
			client.on('error', () => upstream.destroy())
		})
		const port = await listen(proxy)
		const result = await installNetwork({
			env: { HTTP_PROXY: `http://127.0.0.1:${port}` },
			...quiet,
		})
		expect(result.installed).toBe(true)
		// A host that does not exist: only the proxy can get this to the origin.
		const response = await fetch('http://origin.invalid:81/path?x=1')
		expect(await response.text()).toBe('origin saw origin.invalid:81')
		expect(seen).toEqual(['origin.invalid:81'])
	})

	it('lets a host in NO_PROXY go straight to its origin', async () => {
		const viaProxy: string[] = []
		const proxy = createServer((req, res) => {
			viaProxy.push(req.url ?? '')
			res.end('proxy')
		})
		const origin = createServer((_req, res) => res.end('origin'))
		const proxyPort = await listen(proxy)
		const originPort = await listen(origin)
		await installNetwork({
			env: { HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '127.0.0.1' },
			...quiet,
		})
		const response = await fetch(`http://127.0.0.1:${originPort}/`)
		expect(await response.text()).toBe('origin')
		expect(viaProxy).toEqual([])
	})

	it('never sends loopback through the proxy, with no NO_PROXY at all', async () => {
		const viaProxy: string[] = []
		const proxy = createServer()
		proxy.on('connect', (req, socket) => {
			viaProxy.push(req.url ?? '')
			socket.destroy()
		})
		const origin = createServer((_req, res) => res.end('origin'))
		const proxyPort = await listen(proxy)
		const originPort = await listen(origin)
		await installNetwork({ env: { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` }, ...quiet })
		expect(await (await fetch(`http://127.0.0.1:${originPort}/`)).text()).toBe('origin')
		expect(await (await fetch(`http://localhost:${originPort}/`)).text()).toBe('origin')
		expect(viaProxy).toEqual([])
	})

	it('sends everything direct when NO_PROXY is a star', async () => {
		const proxy = createServer((_req, res) => res.end('proxy'))
		const origin = createServer((_req, res) => res.end('origin'))
		const proxyPort = await listen(proxy)
		const originPort = await listen(origin)
		await installNetwork({
			env: { http_proxy: `http://127.0.0.1:${proxyPort}`, no_proxy: '*' },
			...quiet,
		})
		expect(await (await fetch(`http://127.0.0.1:${originPort}/`)).text()).toBe('origin')
	})

	it('changes nothing when nothing is set', async () => {
		const result = await installNetwork({ env: {}, ...quiet })
		expect(result).toEqual({ installed: false, problems: [] })
	})

	it('says an unusable address is ignored and does not route through it', async () => {
		const reported: string[] = []
		const origin = createServer((_req, res) => res.end('origin'))
		const originPort = await listen(origin)
		const result = await installNetwork({
			env: { HTTP_PROXY: 'socks5://proxy:1080' },
			report: (message) => reported.push(message),
		})
		expect(result.installed).toBe(false)
		expect(reported).toHaveLength(1)
		expect(reported[0]).toMatch(/HTTP_PROXY names a socks5 proxy/)
		expect(await (await fetch(`http://127.0.0.1:${originPort}/`)).text()).toBe('origin')
	})
})

describe('a proxy that wants a sign-in', () => {
	function refusingProxy(headers: IncomingHttpHeaders[]): Server {
		const proxy = createServer()
		proxy.on('connect', (req, socket) => {
			headers.push(req.headers)
			socket.end(
				'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="corp"\r\nContent-Length: 0\r\n\r\n',
			)
		})
		return proxy
	}

	it('is told apart from a provider that cannot be reached, and explained in plain words', async () => {
		const headers: IncomingHttpHeaders[] = []
		const port = await listen(refusingProxy(headers))
		await installNetwork({ env: { HTTPS_PROXY: `http://127.0.0.1:${port}` }, ...quiet })
		const failure = await fetch('https://api.example.invalid/v1').then(
			() => undefined,
			(error: unknown) => error,
		)
		expect(failure).toBeDefined()
		// Wrapped the way a vendor SDK wraps a transport failure.
		const wrapped = new Error('Connection error.', { cause: failure })
		const classified = classifyProviderError(wrapped, 'anthropic')
		expect(classified.code).toBe('network')
		expect(classified.retryable).toBe(false)
		const explained = explainError(classified)
		expect(explained?.id).toBe('provider.proxy_auth')
		expect(explained?.message).toBe(
			'The network proxy asked for a sign-in before it would pass the request on.',
		)
		expect(explained?.hint).toContain('HTTPS_PROXY=http://user:password@host:port')
		expect(headers).toHaveLength(1)
		expect(headers[0]?.['proxy-authorization']).toBeUndefined()
	})

	it('is sent the sign-in written in the proxy address', async () => {
		const headers: IncomingHttpHeaders[] = []
		const port = await listen(refusingProxy(headers))
		await installNetwork({
			env: { HTTPS_PROXY: `http://me:pw@127.0.0.1:${port}` },
			...quiet,
		})
		await fetch('https://api.example.invalid/v1').catch(() => undefined)
		expect(headers[0]?.['proxy-authorization']).toBe(
			`Basic ${Buffer.from('me:pw').toString('base64')}`,
		)
	})
})

describe('the client certificate', () => {
	function stubLibrary(): { library: DispatcherLibrary; built: Record<string, unknown>[] } {
		const built: Record<string, unknown>[] = []
		class Agent {
			constructor(options: Record<string, unknown>) {
				built.push(options)
			}
		}
		return {
			built,
			library: { EnvHttpProxyAgent: Agent, setGlobalDispatcher: () => {} },
		}
	}

	function pem(dir: string, name: string, body: string): string {
		const path = join(dir, name)
		writeFileSync(path, `-----BEGIN ${body}-----\nQUJD\n-----END ${body}-----\n`)
		return path
	}

	it('is presented to the servers reached, with its key and passphrase', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-client-cert-'))
		roots.push(dir)
		const { library, built } = stubLibrary()
		const result = await installNetwork({
			env: {
				NAMZU_CLIENT_CERT: pem(dir, 'c.pem', 'CERTIFICATE'),
				NAMZU_CLIENT_KEY: pem(dir, 'k.pem', 'PRIVATE KEY'),
				NAMZU_CLIENT_KEY_PASSPHRASE: 'hunter2',
			},
			library,
			...quiet,
		})
		expect(result.installed).toBe(true)
		const tls = {
			cert: expect.stringContaining('CERTIFICATE'),
			key: expect.stringContaining('PRIVATE KEY'),
			passphrase: 'hunter2',
		}
		expect(built[0]).toMatchObject({
			connect: tls,
			requestTls: tls,
			httpProxy: '',
			httpsProxy: '',
			noProxy: 'localhost,127.0.0.1,[::1]',
		})
	})

	it('accepts a certificate file that holds its key too', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-client-cert-'))
		roots.push(dir)
		const { library, built } = stubLibrary()
		await installNetwork({
			env: { NAMZU_CLIENT_CERT: pem(dir, 'both.pem', 'CERTIFICATE') },
			library,
			...quiet,
		})
		expect(built[0]?.requestTls).not.toHaveProperty('key')
	})

	it.each([
		['a file that is not there', () => '/nonexistent/c.pem'],
		[
			'a file with no certificate in it',
			(dir: string) => {
				const path = join(dir, 'empty.pem')
				writeFileSync(path, 'nothing here')
				return path
			},
		],
	])('is not sent for %s, and the person is told', async (_name, make) => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-client-cert-'))
		roots.push(dir)
		const { library, built } = stubLibrary()
		const reported: string[] = []
		const result = await installNetwork({
			env: { NAMZU_CLIENT_CERT: make(dir) },
			library,
			report: (message) => reported.push(message),
		})
		expect(result.installed).toBe(false)
		expect(built).toEqual([])
		expect(reported).toEqual([
			'NAMZU_CLIENT_CERT does not point to a readable PEM file, so no client certificate is sent.',
		])
	})
})

describe('describeNetwork', () => {
	it('names the proxy host and never its credentials', () => {
		const text = describeNetwork(
			readNetworkSettings({ HTTPS_PROXY: 'http://me:pw@proxy.corp:3128', NO_PROXY: 'localhost' }),
		)
		expect(text).toBe('Requests go through the proxy at proxy.corp:3128, except for localhost.')
		expect(text).not.toContain('pw')
	})

	it('is null when connections go out directly', () => {
		expect(describeNetwork(readNetworkSettings({}))).toBeNull()
	})
})
