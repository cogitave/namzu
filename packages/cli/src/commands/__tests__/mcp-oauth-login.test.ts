import { mkdtempSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { runCli } from '../../cli.js'
import {
	clearMcpOAuthCredentials,
	hasMcpOAuthTokens,
	mcpOAuthPath,
} from '../../integrations/mcp/oauth-store.js'
import { loginMcpServer } from '../mcp-oauth-login.js'

const roots: string[] = []
const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	for (const server of servers.splice(0)) {
		server.closeAllConnections()
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
	for (const root of roots.splice(0)) removeTempDir(root)
})

function json(
	response: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): void {
	response.writeHead(status, { 'content-type': 'application/json', ...headers })
	response.end(JSON.stringify(body))
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = []
	for await (const chunk of request) chunks.push(Buffer.from(chunk))
	return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

interface OAuthFixtureOptions {
	readonly authorizationEndpoint?: string
	readonly authorizationServer?: string
	readonly redirectMcp?: boolean
}

async function startOAuthServer(options: OAuthFixtureOptions = {}): Promise<{
	endpoint: string
	issuer: string
	registered: () => number
	tokenExchanges: () => number
	authorizedRequests: () => number
	resourceHeaderCount: () => number
	authHeaderLeaks: () => readonly string[]
	siblingAuthorization: () => string | undefined
}> {
	let issuer = ''
	let registered = 0
	let tokenExchanges = 0
	let authorizedRequests = 0
	let resourceHeaderCount = 0
	const authHeaderLeaks: string[] = []
	let siblingAuthorization: string | undefined
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', issuer)
		const endpoint = `${issuer}/mcp`
		if (url.pathname !== '/mcp' && request.headers['x-api-key']) authHeaderLeaks.push(url.pathname)
		if (request.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
			json(response, 200, {
				resource: endpoint,
				authorization_servers: [options.authorizationServer ?? issuer],
			})
			return
		}
		if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
			json(response, 200, {
				issuer,
				authorization_endpoint: options.authorizationEndpoint ?? `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				registration_endpoint: `${issuer}/register`,
				response_types_supported: ['code'],
				grant_types_supported: ['authorization_code', 'refresh_token'],
				code_challenge_methods_supported: ['S256'],
				authorization_response_iss_parameter_supported: true,
			})
			return
		}
		if (request.method === 'POST' && url.pathname === '/register') {
			registered++
			const registration = (await bodyOf(request)) as Record<string, unknown>
			json(response, 201, {
				...registration,
				client_id: 'namzu-fixture-client',
				token_endpoint_auth_method: 'none',
			})
			return
		}
		if (request.method === 'POST' && url.pathname === '/token') {
			tokenExchanges++
			const chunks: Buffer[] = []
			for await (const chunk of request) chunks.push(Buffer.from(chunk))
			const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
			if (
				body.get('grant_type') !== 'authorization_code' ||
				body.get('code') !== 'fixture-code' ||
				!body.get('code_verifier')
			) {
				json(response, 400, { error: 'invalid_grant' })
				return
			}
			json(response, 200, {
				access_token: 'fixture-access',
				token_type: 'Bearer',
				refresh_token: 'fixture-refresh',
			})
			return
		}
		if (url.pathname === '/mcp' && request.method === 'POST') {
			if (request.headers['x-api-key'] === 'fixture-api-key') resourceHeaderCount++
			if (request.headers.authorization !== 'Bearer fixture-access') {
				json(
					response,
					401,
					{ error: 'unauthorized' },
					{
						'www-authenticate': `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`,
					},
				)
				return
			}
			authorizedRequests++
			if (options.redirectMcp) {
				response.writeHead(307, { location: `${issuer}/sibling` })
				response.end()
				return
			}
			const message = (await bodyOf(request)) as { id?: number | string; method?: string }
			if (message.method === 'notifications/initialized') {
				response.writeHead(202)
				response.end()
				return
			}
			if (message.method === 'server/discover') {
				json(response, 200, {
					jsonrpc: '2.0',
					id: message.id,
					error: { code: -32601, message: 'Method not found' },
				})
				return
			}
			if (message.method === 'initialize') {
				json(response, 200, {
					jsonrpc: '2.0',
					id: message.id,
					result: {
						protocolVersion: '2025-06-18',
						capabilities: { tools: {} },
						serverInfo: { name: 'oauth-fixture', version: '1.0.0' },
					},
				})
				return
			}
			json(response, 200, { jsonrpc: '2.0', id: message.id, result: {} })
			return
		}
		if (url.pathname === '/mcp' && (request.method === 'GET' || request.method === 'DELETE')) {
			response.writeHead(request.method === 'GET' ? 405 : 200)
			response.end()
			return
		}
		if (url.pathname === '/sibling') {
			siblingAuthorization = request.headers.authorization
			response.writeHead(200)
			response.end()
			return
		}
		response.writeHead(404)
		response.end()
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('Fixture did not start')
	issuer = `http://127.0.0.1:${address.port}`
	return {
		endpoint: `${issuer}/mcp`,
		issuer,
		registered: () => registered,
		tokenExchanges: () => tokenExchanges,
		authorizedRequests: () => authorizedRequests,
		resourceHeaderCount: () => resourceHeaderCount,
		authHeaderLeaks: () => authHeaderLeaks,
		siblingAuthorization: () => siblingAuthorization,
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((answer) => {
		resolve = answer
	})
	return { promise, resolve }
}

it('signs in through official MCP discovery, DCR, PKCE, issuer check and a loopback callback', async () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-mcp-oauth-login-'))
	roots.push(home)
	vi.stubEnv('NAMZU_HOME', home)
	const fixture = await startOAuthServer()
	const authorization = deferred<string>()
	const login = loginMcpServer({
		name: 'fixture',
		endpoint: fixture.endpoint,
		headers: { 'X-API-Key': 'fixture-api-key' },
		noBrowser: true,
		timeoutMs: 300_000,
		print: (value) => {
			if (typeof value.url === 'string') authorization.resolve(value.url)
		},
	})
	login.catch(() => {})
	const auth = new URL(await authorization.promise)
	expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
	expect(auth.searchParams.get('resource')).toBe(fixture.endpoint)
	const redirect = auth.searchParams.get('redirect_uri')
	expect(redirect).toBeTruthy()
	const callback = new URL(redirect as string)
	callback.searchParams.set('code', 'fixture-code')
	callback.searchParams.set('state', auth.searchParams.get('state') ?? '')
	callback.searchParams.set('iss', fixture.issuer)
	const browser = await fetch(callback)
	expect(browser.status).toBe(200)
	await login
	expect(fixture.registered()).toBe(1)
	expect(fixture.tokenExchanges()).toBe(1)
	expect(fixture.authorizedRequests()).toBeGreaterThan(0)
	expect(fixture.resourceHeaderCount()).toBeGreaterThan(0)
	expect(fixture.authHeaderLeaks()).toEqual([])
	expect(hasMcpOAuthTokens(fixture.endpoint)).toBe(true)
	expect(mcpOAuthPath(fixture.endpoint)).toContain(home)
	expect(clearMcpOAuthCredentials(fixture.endpoint)).toBe(true)
	expect(hasMcpOAuthTokens(fixture.endpoint)).toBe(false)
})

it('rejects an invalid state and refuses to exchange a code from another issuer', async () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-mcp-oauth-login-'))
	roots.push(home)
	vi.stubEnv('NAMZU_HOME', home)
	const fixture = await startOAuthServer()
	const authorization = deferred<string>()
	const login = loginMcpServer({
		name: 'fixture',
		endpoint: fixture.endpoint,
		noBrowser: true,
		timeoutMs: 300_000,
		print: (value) => {
			if (typeof value.url === 'string') authorization.resolve(value.url)
		},
	})
	login.catch(() => {})
	const auth = new URL(await authorization.promise)
	const callback = new URL(auth.searchParams.get('redirect_uri') as string)
	callback.searchParams.set('code', 'fixture-code')
	callback.searchParams.set('state', 'wrong-state')
	callback.searchParams.set('iss', fixture.issuer)
	expect((await fetch(callback)).status).toBe(400)
	callback.searchParams.set('state', auth.searchParams.get('state') ?? '')
	callback.searchParams.set('iss', 'http://127.0.0.1:1')
	expect((await fetch(callback)).status).toBe(400)
	await expect(login).rejects.toThrow('MCP sign-in failed')
	expect(fixture.tokenExchanges()).toBe(0)
	expect(hasMcpOAuthTokens(fixture.endpoint)).toBe(false)
})

it('routes mcp login and logout through the effective CLI config without showing token values', async () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-mcp-oauth-command-'))
	roots.push(home)
	vi.stubEnv('NAMZU_HOME', home)
	const fixture = await startOAuthServer()
	writeFileSync(
		join(home, 'config.yaml'),
		`mcpServers:\n  fixture:\n    url: ${fixture.issuer}/base\nprofiles:\n  alternate:\n    mcpServers:\n      fixture:\n        url: ${fixture.endpoint}\n`,
	)
	const output: Record<string, unknown>[] = []
	const authorization = deferred<string>()
	vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		try {
			const value = JSON.parse(String(chunk)) as Record<string, unknown>
			output.push(value)
			if (typeof value.url === 'string') authorization.resolve(value.url)
		} catch {
			/* other CLI output */
		}
		return true
	})
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
	const login = runCli({
		argv: [
			'node',
			'namzu',
			'--format',
			'json',
			'--profile',
			'alternate',
			'mcp',
			'login',
			'fixture',
			'--no-browser',
		],
	})
	login.catch(() => {})
	const auth = new URL(await authorization.promise)
	const callback = new URL(auth.searchParams.get('redirect_uri') as string)
	callback.searchParams.set('code', 'fixture-code')
	callback.searchParams.set('state', auth.searchParams.get('state') ?? '')
	callback.searchParams.set('iss', fixture.issuer)
	expect((await fetch(callback)).status).toBe(200)
	expect(await login).toBe(0)
	expect(hasMcpOAuthTokens(fixture.endpoint)).toBe(true)
	expect(JSON.stringify(output)).not.toContain('fixture-access')
	expect(
		await runCli({ argv: ['node', 'namzu', '--profile', 'alternate', 'mcp', 'logout', 'fixture'] }),
	).toBe(0)
	expect(hasMcpOAuthTokens(fixture.endpoint)).toBe(false)
})

it('refuses an authorization page on remote cleartext HTTP before opening it', async () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-mcp-oauth-login-'))
	roots.push(home)
	vi.stubEnv('NAMZU_HOME', home)
	const fixture = await startOAuthServer({ authorizationEndpoint: 'http://example.com/authorize' })
	const output: unknown[] = []
	await expect(
		loginMcpServer({
			name: 'fixture',
			endpoint: fixture.endpoint,
			noBrowser: true,
			timeoutMs: 300_000,
			print: (value) => {
				output.push(value)
			},
		}),
	).rejects.toThrow('MCP sign-in failed')
	expect(output).toEqual([])
	expect(fixture.tokenExchanges()).toBe(0)
	expect(hasMcpOAuthTokens(fixture.endpoint)).toBe(false)
})

it('does not forward a saved Bearer token to a same-origin redirect', async () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-mcp-oauth-login-'))
	roots.push(home)
	vi.stubEnv('NAMZU_HOME', home)
	const fixture = await startOAuthServer({ redirectMcp: true })
	const authorization = deferred<string>()
	const login = loginMcpServer({
		name: 'fixture',
		endpoint: fixture.endpoint,
		noBrowser: true,
		timeoutMs: 300_000,
		print: (value) => {
			if (typeof value.url === 'string') authorization.resolve(value.url)
		},
	})
	login.catch(() => {})
	const auth = new URL(await authorization.promise)
	const callback = new URL(auth.searchParams.get('redirect_uri') as string)
	callback.searchParams.set('code', 'fixture-code')
	callback.searchParams.set('state', auth.searchParams.get('state') ?? '')
	callback.searchParams.set('iss', fixture.issuer)
	expect((await fetch(callback)).status).toBe(400)
	await expect(login).rejects.toThrow('MCP sign-in failed')
	expect(fixture.siblingAuthorization()).toBeUndefined()
	expect(fixture.tokenExchanges()).toBe(1)
})

it('does not fetch cleartext authorization-server metadata on a non-loopback address', async () => {
	const home = mkdtempSync(join(tmpdir(), 'namzu-mcp-oauth-login-'))
	roots.push(home)
	vi.stubEnv('NAMZU_HOME', home)
	const fixture = await startOAuthServer({ authorizationServer: 'http://169.254.169.254' })
	const output: unknown[] = []
	await expect(
		loginMcpServer({
			name: 'fixture',
			endpoint: fixture.endpoint,
			noBrowser: true,
			timeoutMs: 300_000,
			print: (value) => {
				output.push(value)
			},
		}),
	).rejects.toThrow('MCP sign-in failed')
	expect(output).toEqual([])
	expect(fixture.registered()).toBe(0)
})
