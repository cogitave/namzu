import { mkdirSync, mkdtempSync } from 'node:fs'
import { type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { OAuthDiscoveryState } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { createMcpOAuthProvider } from '../oauth-store.js'
import { connectMcpServers } from '../servers.js'

interface RecordedRequest {
	readonly method: string
	readonly path: string
	readonly authorization?: string
}

let home: string
let previousNamzuHome: string | undefined
const servers: Server[] = []

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-mcp-oauth-runtime-'))
	mkdirSync(join(home, '.namzu'), { mode: 0o700 })
	previousNamzuHome = process.env.NAMZU_HOME
	process.env.NAMZU_HOME = join(home, '.namzu')
})

afterEach(async () => {
	if (previousNamzuHome === undefined) Reflect.deleteProperty(process.env, 'NAMZU_HOME')
	else process.env.NAMZU_HOME = previousNamzuHome
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections()
					server.close(() => resolve())
				}),
		),
	)
	removeTempDir(home)
})

async function startMcpServer(
	allowedToken: string,
	refresh?: { readonly from: string; readonly to: string; readonly redirectTo?: string },
	forbidden = false,
	expiredBarrier?: { readonly authorization: string; readonly count: number },
	redirectTo?: string,
): Promise<{
	readonly url: string
	readonly requests: RecordedRequest[]
}> {
	const requests: RecordedRequest[] = []
	const heldExpiredResponses: ServerResponse[] = []
	const server = createServer(async (request, response) => {
		let body = ''
		for await (const chunk of request) body += String(chunk)
		let method = ''
		try {
			method = (JSON.parse(body) as { method?: string }).method ?? ''
		} catch {
			// The OAuth middleware can request metadata by GET after a 401.
		}
		requests.push({
			method,
			path: request.url ?? '',
			authorization: request.headers.authorization,
		})
		if (forbidden) {
			response.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden')
			return
		}
		if (
			expiredBarrier &&
			method === 'server/discover' &&
			request.headers.authorization === expiredBarrier.authorization
		) {
			heldExpiredResponses.push(response)
			if (heldExpiredResponses.length === expiredBarrier.count) {
				for (const held of heldExpiredResponses) {
					held.writeHead(401, { 'content-type': 'text/plain' }).end('expired')
				}
			}
			return
		}
		if (request.url === '/token' && refresh) {
			if (refresh.redirectTo) {
				response.writeHead(307, { location: refresh.redirectTo }).end()
				return
			}
			const parameters = new URLSearchParams(body)
			if (
				parameters.get('grant_type') === 'refresh_token' &&
				parameters.get('refresh_token') === refresh.from
			) {
				response
					.writeHead(200, { 'content-type': 'application/json' })
					.end(JSON.stringify({ access_token: refresh.to, token_type: 'Bearer' }))
				return
			}
		}
		if (request.headers.authorization !== allowedToken) {
			response.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized')
			return
		}
		if (redirectTo && request.url === '/mcp/private') {
			response.writeHead(307, { location: redirectTo }).end()
			return
		}
		const id = (JSON.parse(body) as { id?: number }).id
		if (method === 'server/discover') {
			response.writeHead(200, { 'content-type': 'application/json' }).end(
				JSON.stringify({
					jsonrpc: '2.0',
					id,
					result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
				}),
			)
			return
		}
		if (method === 'tools/list') {
			response
				.writeHead(200, { 'content-type': 'application/json' })
				.end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } }))
			return
		}
		response.writeHead(202).end()
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject)
			resolve()
		})
	})
	servers.push(server)
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }
}

async function saveGrant(
	endpoint: string,
	token: string,
	options: {
		readonly issuer?: string
		readonly refreshToken?: string
		readonly discovery?: OAuthDiscoveryState
	} = {},
): Promise<void> {
	const issuer = options.issuer ?? 'https://issuer.example.invalid'
	const provider = createMcpOAuthProvider({
		endpoint,
		redirectUrl: 'http://127.0.0.1:39177/callback',
		onRedirect: () => {},
	})
	await provider.clientInformation({ issuer })
	await provider.saveClientInformation?.({ client_id: 'runtime-test', issuer }, { issuer })
	if (options.discovery) await provider.saveDiscoveryState?.(options.discovery)
	await provider.tokens({ issuer })
	await provider.saveTokens(
		{
			access_token: token,
			token_type: 'Bearer',
			issuer,
			...(options.refreshToken ? { refresh_token: options.refreshToken } : {}),
		},
		{ issuer },
	)
}

function discoveryFor(origin: string, endpoint: string): OAuthDiscoveryState {
	return {
		authorizationServerUrl: origin,
		resourceMetadata: { resource: endpoint, authorization_servers: [origin] },
		authorizationServerMetadata: {
			issuer: origin,
			authorization_endpoint: `${origin}/authorize`,
			token_endpoint: `${origin}/token`,
			response_types_supported: ['code'],
		},
	}
}

describe('saved MCP OAuth in a running CLI session', () => {
	it('attaches a saved token to the exact configured endpoint', async () => {
		const origin = await startMcpServer('Bearer saved-token')
		const endpoint = `${origin.url}/mcp/private`
		await saveGrant(endpoint, 'saved-token')

		const connection = await connectMcpServers({ private: { url: endpoint } }, { cwd: home })
		try {
			expect(connection.failed).toEqual([])
			expect(connection.connected.map((server) => server.name)).toEqual(['private'])
			expect(origin.requests.map((request) => request.method)).toContain('server/discover')
			expect(
				origin.requests.every((request) => request.authorization === 'Bearer saved-token'),
			).toBe(true)
		} finally {
			await connection.close()
		}
	})

	it('does not offer a saved token to a sibling path on the same origin', async () => {
		const origin = await startMcpServer('Bearer saved-token')
		await saveGrant(`${origin.url}/mcp/private`, 'saved-token')

		const connection = await connectMcpServers(
			{ sibling: { url: `${origin.url}/mcp/sibling` } },
			{ cwd: home },
		)
		try {
			expect(connection.connected).toEqual([])
			expect(connection.failed[0]?.reason).toContain('HTTP 401')
			expect(origin.requests.every((request) => request.authorization === undefined)).toBe(true)
			expect(origin.requests.map((request) => request.method)).toEqual(['server/discover'])
		} finally {
			await connection.close()
		}
	})

	it('lets an explicit Authorization header take precedence over a saved OAuth token', async () => {
		const origin = await startMcpServer('Bearer configured-token')
		const endpoint = `${origin.url}/mcp/private`
		await saveGrant(endpoint, 'saved-token')

		const connection = await connectMcpServers(
			{ private: { url: endpoint, headers: { authorization: 'Bearer configured-token' } } },
			{ cwd: home },
		)
		try {
			expect(connection.failed).toEqual([])
			expect(
				origin.requests.every((request) => request.authorization === 'Bearer configured-token'),
			).toBe(true)
		} finally {
			await connection.close()
		}
	})

	it('keeps a 401 after saved OAuth on the refusal path without a legacy handshake', async () => {
		const origin = await startMcpServer('Bearer other-token')
		const endpoint = `${origin.url}/mcp/private`
		await saveGrant(endpoint, 'expired-token')

		const connection = await connectMcpServers({ private: { url: endpoint } }, { cwd: home })
		try {
			expect(connection.connected).toEqual([])
			expect(connection.failed[0]?.reason).toMatch(/HTTP 401.*mcp login/i)
			expect(origin.requests.some((request) => request.method === 'server/discover')).toBe(true)
			expect(origin.requests.some((request) => request.method === 'initialize')).toBe(false)
		} finally {
			await connection.close()
		}
	})

	it('keeps a 403 with saved OAuth on the refusal path without a legacy handshake', async () => {
		const origin = await startMcpServer('Bearer saved-token', undefined, true)
		const endpoint = `${origin.url}/mcp/private`
		await saveGrant(endpoint, 'saved-token')

		const connection = await connectMcpServers({ private: { url: endpoint } }, { cwd: home })
		try {
			expect(connection.connected).toEqual([])
			expect(connection.failed[0]?.reason).toContain('HTTP 403')
			expect(origin.requests.map((request) => request.method)).toEqual(['server/discover'])
		} finally {
			await connection.close()
		}
	})

	it('does not follow a same-origin redirect with a saved bearer token', async () => {
		const origin = await startMcpServer(
			'Bearer saved-token',
			undefined,
			false,
			undefined,
			'/mcp/other',
		)
		const endpoint = `${origin.url}/mcp/private`
		await saveGrant(endpoint, 'saved-token')

		const connection = await connectMcpServers({ private: { url: endpoint } }, { cwd: home })
		try {
			expect(connection.connected).toEqual([])
			expect(connection.failed[0]?.reason).toMatch(/configure the final MCP endpoint directly/i)
			expect(origin.requests.every((request) => request.path === '/mcp/private')).toBe(true)
			expect(
				origin.requests.every((request) => request.authorization === 'Bearer saved-token'),
			).toBe(true)
		} finally {
			await connection.close()
		}
	})

	it('refreshes a saved grant with the official OAuth middleware before retrying MCP', async () => {
		const origin = await startMcpServer('Bearer renewed-token', {
			from: 'saved-refresh',
			to: 'renewed-token',
		})
		const endpoint = `${origin.url}/mcp/private`
		const issuer = origin.url
		await saveGrant(endpoint, 'expired-token', {
			issuer,
			refreshToken: 'saved-refresh',
			discovery: discoveryFor(origin.url, endpoint),
		})

		const connection = await connectMcpServers({ private: { url: endpoint } }, { cwd: home })
		try {
			expect(connection.failed).toEqual([])
			expect(connection.connected.map((server) => server.name)).toEqual(['private'])
			expect(origin.requests.filter((request) => request.path === '/token')).toHaveLength(1)
			expect(
				origin.requests
					.filter((request) => request.method === 'server/discover')
					.map((r) => r.authorization),
			).toEqual(['Bearer expired-token', 'Bearer renewed-token'])
			expect(origin.requests.some((request) => request.method === 'initialize')).toBe(false)
		} finally {
			await connection.close()
		}
	})

	it('does not forward a refresh token when the token endpoint redirects', async () => {
		const forwardedBodies: string[] = []
		const receiver = createServer(async (request, response) => {
			let body = ''
			for await (const chunk of request) body += String(chunk)
			forwardedBodies.push(body)
			response
				.writeHead(200, { 'content-type': 'application/json' })
				.end(JSON.stringify({ access_token: 'stolen-token', token_type: 'Bearer' }))
		})
		await new Promise<void>((resolve, reject) => {
			receiver.once('error', reject)
			receiver.listen(0, '127.0.0.1', () => {
				receiver.off('error', reject)
				resolve()
			})
		})
		servers.push(receiver)
		const receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/capture`
		const origin = await startMcpServer('Bearer renewed-token', {
			from: 'saved-refresh',
			to: 'renewed-token',
			redirectTo: receiverUrl,
		})
		const endpoint = `${origin.url}/mcp/private`
		await saveGrant(endpoint, 'expired-token', {
			issuer: origin.url,
			refreshToken: 'saved-refresh',
			discovery: discoveryFor(origin.url, endpoint),
		})

		const connection = await connectMcpServers({ private: { url: endpoint } }, { cwd: home })
		try {
			expect(connection.connected).toEqual([])
			expect(connection.failed[0]?.reason).toMatch(/HTTP 401.*mcp login/i)
			expect(origin.requests.filter((request) => request.path === '/token')).toHaveLength(1)
			expect(forwardedBodies).toEqual([])
		} finally {
			await connection.close()
		}
	})

	it('coalesces two simultaneous 401 refreshes without serializing their requests', async () => {
		const origin = await startMcpServer(
			'Bearer renewed-token',
			{ from: 'saved-refresh', to: 'renewed-token' },
			false,
			{ authorization: 'Bearer expired-token', count: 2 },
		)
		const endpoint = `${origin.url}/mcp/private`
		await saveGrant(endpoint, 'expired-token', {
			issuer: origin.url,
			refreshToken: 'saved-refresh',
			discovery: discoveryFor(origin.url, endpoint),
		})

		// The server withholds both expired-token replies until both requests
		// arrive. A whole-fetch mutex would deadlock here; only refresh may
		// serialize, after each independent request receives its 401.
		const [first, second] = await Promise.all([
			connectMcpServers({ first: { url: endpoint } }, { cwd: home }),
			connectMcpServers({ second: { url: endpoint } }, { cwd: home }),
		])
		try {
			expect(first.failed).toEqual([])
			expect(second.failed).toEqual([])
			expect(origin.requests.filter((request) => request.path === '/token')).toHaveLength(1)
			expect(
				origin.requests
					.filter((request) => request.method === 'server/discover')
					.map((r) => r.authorization),
			).toEqual([
				'Bearer expired-token',
				'Bearer expired-token',
				'Bearer renewed-token',
				'Bearer renewed-token',
			])
		} finally {
			await Promise.all([first.close(), second.close()])
		}
	})
})
