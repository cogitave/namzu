/** Explicit, interactive OAuth sign-in for one configured HTTP MCP server. */

import { once } from 'node:events'
import { type Server, type ServerResponse, createServer } from 'node:http'

import {
	Client,
	StreamableHTTPClientTransport,
	UnauthorizedError,
} from '@modelcontextprotocol/client'

import {
	clearMcpOAuthPending,
	consumeMcpOAuthCallbackState,
	createMcpOAuthProvider,
	isSecureMcpOAuthUrl,
} from '../integrations/mcp/oauth-store.js'
import { openInBrowser } from '../tui/open-browser.js'
import { firstStdinLine } from './login.js'

const CALLBACK_PATH = '/callback'
const MAX_CALLBACK_URL_LENGTH = 8192

export interface McpOAuthLoginOptions {
	readonly name: string
	readonly endpoint: string
	readonly headers?: Readonly<Record<string, string>>
	readonly noBrowser: boolean
	readonly timeoutMs: number
	readonly print: (value: { readonly text: string; readonly [key: string]: unknown }) => void
}

interface Callback {
	readonly params: URLSearchParams
	readonly response?: ServerResponse
}

function callbackPage(response: ServerResponse, status: number, text: string): void {
	response.writeHead(status, {
		'content-type': 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
	})
	response.end(text)
}

function callbackParams(url: URL, expectedOrigin: string): URLSearchParams {
	if (url.origin !== expectedOrigin || url.pathname !== CALLBACK_PATH || url.hash) {
		throw new Error('The callback address does not match this sign-in.')
	}
	const params = url.searchParams
	if (
		params.getAll('state').length !== 1 ||
		params.getAll('code').length > 1 ||
		params.getAll('iss').length > 1
	) {
		throw new Error('The callback parameters are invalid.')
	}
	return params
}

function remaining(deadline: number): number {
	return Math.max(1, deadline - Date.now())
}

async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error('Timed out waiting for MCP sign-in.')),
					remaining(deadline),
				)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

async function closeListener(server: Server): Promise<void> {
	server.closeAllConnections()
	if (!server.listening) return
	await new Promise<void>((resolve) => server.close(() => resolve()))
}

/**
 * Start a loopback callback before asking the official MCP client to discover
 * authorization. The SDK validates the authorization-server issuer and exchanges
 * the code; Namzu validates the callback's one-shot state before calling it.
 */
export async function loginMcpServer(options: McpOAuthLoginOptions): Promise<void> {
	if (Object.keys(options.headers ?? {}).some((name) => name.toLowerCase() === 'authorization')) {
		throw new Error('Remove the configured Authorization header before MCP OAuth sign-in.')
	}
	let acceptCallback: ((value: Callback) => void) | undefined
	const callback = new Promise<Callback>((resolve) => {
		acceptCallback = resolve
	})
	let callbackOrigin = ''
	const server = createServer((request, response) => {
		if (
			request.method !== 'GET' ||
			request.socket.remoteAddress !== '127.0.0.1' ||
			request.headers.host !== callbackOrigin.slice('http://'.length) ||
			!request.url ||
			request.url.length > MAX_CALLBACK_URL_LENGTH
		) {
			callbackPage(response, 400, 'This is not the MCP sign-in callback.\n')
			return
		}
		try {
			const url = new URL(request.url, callbackOrigin)
			const params = callbackParams(url, callbackOrigin)
			consumeMcpOAuthCallbackState(options.endpoint, params.get('state'))
			acceptCallback?.({ params, response })
			acceptCallback = undefined
		} catch {
			callbackPage(response, 400, 'The MCP sign-in callback was refused.\n')
		}
	})
	server.listen(0, '127.0.0.1')
	try {
		await once(server, 'listening')
	} catch (error) {
		server.close()
		throw error
	}
	const address = server.address()
	if (!address || typeof address === 'string') {
		await closeListener(server)
		throw new Error('Could not reserve a loopback callback port.')
	}
	callbackOrigin = `http://127.0.0.1:${address.port}`
	const redirectUrl = `${callbackOrigin}${CALLBACK_PATH}`
	const abortInput = new AbortController()
	const deadline = Date.now() + options.timeoutMs
	let authorizationUrl: URL | undefined
	let client: Client | undefined
	let providerStarted = false
	let firstTransport: StreamableHTTPClientTransport | undefined
	let browserResponse: ServerResponse | undefined
	try {
		const provider = createMcpOAuthProvider({
			endpoint: options.endpoint,
			redirectUrl,
			onRedirect: (url) => {
				if (!isSecureMcpOAuthUrl(url)) {
					throw new Error('MCP authorization page must use HTTPS or loopback HTTP.')
				}
				authorizationUrl = url
			},
		})
		providerStarted = true
		client = new Client(
			{ name: 'namzu-cli', version: '1.0.0' },
			{ versionNegotiation: { mode: 'auto' } },
		)
		const transport = () =>
			new StreamableHTTPClientTransport(new URL(options.endpoint), {
				authProvider: provider,
				// The official transport also uses its fetch for OAuth discovery,
				// registration and token exchange. Put configured resource headers
				// only on the exact MCP endpoint, never in requestInit, which the
				// official client would merge into the authorization-server calls.
				// Manual redirects keep both headers and the Bearer token on this
				// one URL, including for same-origin 307/308 responses.
				fetch: (input, init) => {
					const targetUrl = new URL(String(input))
					if (!isSecureMcpOAuthUrl(targetUrl)) {
						throw new Error('MCP OAuth network requests require HTTPS or loopback HTTP.')
					}
					const isResource = targetUrl.href === new URL(options.endpoint).href
					const headers = new Headers(init?.headers)
					if (isResource) {
						for (const [name, value] of Object.entries(options.headers ?? {}))
							headers.set(name, value)
					}
					return fetch(input, { ...init, headers, redirect: 'manual' })
				},
			})
		firstTransport = transport()
		try {
			await beforeDeadline(client.connect(firstTransport), deadline)
			options.print({
				name: options.name,
				text: `MCP server ${options.name} is already signed in.`,
			})
			return
		} catch (error) {
			if (!(error instanceof UnauthorizedError) || !authorizationUrl) throw error
		}
		const url = authorizationUrl.href
		const opened = options.noBrowser ? false : openInBrowser(url)
		options.print({
			name: options.name,
			url,
			text: [
				`Authorize MCP server ${options.name} in your browser:`,
				url,
				opened
					? 'Waiting for the browser callback.'
					: 'Paste the complete callback URL here, or open the URL on this machine.',
			].join('\n'),
		})
		// A remote/headless terminal can paste the complete callback URL instead
		// of forwarding the loopback port. A closed stdin simply leaves the live
		// loopback listener waiting; it must not end sign-in early.
		const pasted = firstStdinLine(abortInput.signal).then((line): Promise<Callback> => {
			if (line === null) return new Promise<Callback>(() => {})
			const parsed = new URL(line.trim())
			const params = callbackParams(parsed, callbackOrigin)
			consumeMcpOAuthCallbackState(options.endpoint, params.get('state'))
			return Promise.resolve({ params })
		})
		const result = await beforeDeadline(Promise.race([callback, pasted]), deadline)
		browserResponse = result.response
		// Pass the complete query. The official SDK checks the RFC 9207 `iss`
		// value before it redeems the code; the host checked `state` above.
		await beforeDeadline(firstTransport.finishAuth(result.params), deadline)
		await beforeDeadline(client.connect(transport()), deadline)
		if (browserResponse)
			callbackPage(browserResponse, 200, 'MCP sign-in complete. You may close this tab.\n')
		browserResponse = undefined
		options.print({ name: options.name, text: `Signed in to MCP server ${options.name}.` })
	} catch (error) {
		if (browserResponse)
			callbackPage(browserResponse, 400, 'MCP sign-in failed. Return to the terminal.\n')
		// Never render callback-supplied error_description or a server's OAuth
		// error text. It may be attacker controlled in an AS mix-up.
		if (error instanceof Error && error.message === 'Timed out waiting for MCP sign-in.')
			throw error
		throw new Error('MCP sign-in failed. Check the server configuration and try again.')
	} finally {
		abortInput.abort()
		try {
			if (providerStarted) clearMcpOAuthPending(options.endpoint)
		} finally {
			await Promise.allSettled([client?.close(), closeListener(server)])
		}
	}
}
