import { lookup as dnsLookup } from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import { isIP } from 'node:net'

import type { WebSocket as WebSocketClient } from 'ws'

import { isPrivateAddress } from '../../connector/web/guarded-fetch.js'
import { isolationOf } from '../../sandbox/isolation.js'
import type { Sandbox } from '../../types/sandbox/index.js'
import type { MonitorWebSocketTarget } from '../../types/tool/index.js'
import type { JobHost, JobSource } from './registry.js'

/**
 * A WebSocket as a monitor's source.
 *
 * A command's stdout is not the only thing worth watching: some services push
 * their events (a CI run's log stream, a server's change feed) and offer no
 * command that prints them. This module turns such a connection into the same
 * thing a command is to the registry: a process-shaped object that writes
 * lines on stdout, can be asked to stop, and ends. Everything after that (the
 * 200 ms batches, the rationing, the expiry, the stop, the untrusted frame the
 * model reads it in) is the registry's and is shared with commands unchanged.
 *
 * What is different is where it runs and what it can reach. A command runs
 * where the registry's spawn puts it, inside a sandbox if there is one; this
 * connection is opened by the HOST process, outside any sandbox. So the
 * address is checked before anything is sent, a sandbox that isolates the
 * network refuses it unless it has said the host is allowed, and the tool
 * asks a person first (see `tools/builtins/monitor.ts`).
 */

/** The largest frame accepted; a bigger one ends the watch. */
export const WEBSOCKET_MAX_PAYLOAD_BYTES = 1_048_576
export const WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 15_000
/** After a polite close, how long a peer gets to answer before the socket is destroyed. */
export const WEBSOCKET_CLOSE_GRACE_MS = 1000
export const WEBSOCKET_URL_MAX_CHARS = 2048
export const WEBSOCKET_PROTOCOLS_MAX = 16
/** Longest close reason relayed; the protocol allows 123 bytes. */
const CLOSE_REASON_MAX_CHARS = 123

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** RFC 6455 subprotocol names are RFC 2616 tokens: no separators, no controls. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** Why a URL cannot be a monitor's source, or undefined when it can. */
export function webSocketUrlProblem(raw: string): string | undefined {
	if (raw.length > WEBSOCKET_URL_MAX_CHARS) {
		return `The URL is longer than ${WEBSOCKET_URL_MAX_CHARS} characters.`
	}
	// ASCII without whitespace or controls: a model that wants a non-ASCII host
	// writes it in punycode, and nothing here is left to the parser's leniency
	// (it strips tabs and newlines silently).
	if (!/^[\x21-\x7e]+$/.test(raw)) {
		return 'The URL must be ASCII, with no spaces or control characters.'
	}
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return 'That is not a URL.'
	}
	if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
		return 'The URL must start with ws:// or wss://.'
	}
	if (url.username !== '' || url.password !== '') {
		return 'A URL with a user name or password is not opened.'
	}
	if (url.hash !== '') return 'A WebSocket URL cannot have a fragment (#...).'
	if (url.hostname === '') return 'The URL has no host.'
	return undefined
}

/** Why a subprotocol list is not valid, or undefined when it is. */
export function webSocketProtocolsProblem(protocols: readonly string[]): string | undefined {
	if (protocols.length > WEBSOCKET_PROTOCOLS_MAX) {
		return `At most ${WEBSOCKET_PROTOCOLS_MAX} subprotocols.`
	}
	for (const protocol of protocols) {
		if (!TOKEN.test(protocol)) return `"${protocol}" is not a valid subprotocol name.`
	}
	if (new Set(protocols).size !== protocols.length) return 'Subprotocol names must be unique.'
	return undefined
}

/** What a record and an approval call this source: the URL as given, which can carry no credentials. */
export function webSocketJobCommand(url: string): string {
	return `websocket ${url}`
}

// ---------------------------------------------------------------------------
// Where it may connect
// ---------------------------------------------------------------------------

/** The address check refused, in words for the model. */
export class WebSocketRefusedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'WebSocketRefusedError'
	}
}

export interface WebSocketVetOptions {
	/**
	 * How a name becomes addresses. Defaults to `node:dns`. For tests only, and
	 * never reachable from a tool argument: the hook belongs to whoever builds
	 * the tool (`createMonitorTool`).
	 */
	readonly resolve?: (hostname: string) => Promise<readonly string[]>
	/**
	 * Allow addresses inside the host's own network. For tests only: a local
	 * server on 127.0.0.1 is the one honest reason to, and it is a decision the
	 * code that builds the tool makes, never the model.
	 */
	readonly allowPrivateAddresses?: boolean
}

/** The host name of a WebSocket URL as a resolver or an address check wants it. */
export function webSocketHostname(raw: string): string {
	return new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '')
}

/**
 * Resolve the host and refuse unless EVERY address is outside the host's own
 * network; return the addresses that were checked.
 *
 * Refusal covers a name that does not resolve, one that resolves to nothing,
 * and one with any private address among its answers: a name that answers both
 * a public and a private address is a name an attacker controls, and a
 * connection may pick either. Failing to resolve is a refusal and never a
 * pass: an empty list satisfies "no private address found" and the connection
 * that followed would resolve the name again against whatever answered.
 */
export async function vetWebSocketTarget(
	raw: string,
	options: WebSocketVetOptions = {},
): Promise<readonly { readonly address: string; readonly family: 4 | 6 }[]> {
	const hostname = webSocketHostname(raw)
	let addresses: readonly string[]
	const literal = isIP(hostname)
	if (literal !== 0) {
		addresses = [hostname]
	} else {
		const resolve =
			options.resolve ??
			(async (name: string) => (await dnsLookup(name, { all: true })).map((r) => r.address))
		try {
			addresses = await resolve(hostname)
		} catch (err) {
			throw new WebSocketRefusedError(
				`Refused "${hostname}": it could not be resolved (${err instanceof Error ? err.message : String(err)}), so nothing here can say where it points.`,
			)
		}
		if (addresses.length === 0) {
			throw new WebSocketRefusedError(`Refused "${hostname}": it resolves to no addresses.`)
		}
	}
	if (options.allowPrivateAddresses !== true) {
		for (const address of addresses) {
			if (isPrivateAddress(address)) {
				throw new WebSocketRefusedError(
					`Refused "${hostname}": it resolves to ${address}, inside this host's own network. A WebSocket monitor only connects to public addresses.`,
				)
			}
		}
	}
	return addresses.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 }))
}

/**
 * A `lookup` for the socket that answers with the addresses that were checked
 * and nothing else.
 *
 * This is what closes the gap `web_fetch` documents: there the address is
 * checked, then the platform `fetch` resolves the name AGAIN, so a name that
 * answers publicly the first time and privately the second (DNS rebinding)
 * gets through. Here the connection never asks DNS: it is handed the checked
 * addresses, so there is no second answer to differ. The URL still names the
 * host, so TLS keeps its SNI and its certificate check on the hostname and not
 * on an address.
 */
export function pinnedLookup(
	addresses: readonly { readonly address: string; readonly family: 4 | 6 }[],
) {
	return (
		_hostname: string,
		options: { all?: boolean; family?: number | string } | undefined,
		callback: (
			error: NodeJS.ErrnoException | null,
			address: string | { address: string; family: number }[],
			family?: number,
		) => void,
	): void => {
		// A caller that wants one family gets that family's addresses; asking for
		// one we hold none of is an error rather than a fall back to DNS.
		const wanted = options?.family === 4 || options?.family === 6 ? options.family : undefined
		const usable = wanted === undefined ? addresses : addresses.filter((a) => a.family === wanted)
		const first = usable[0]
		if (first === undefined) {
			const error: NodeJS.ErrnoException = new Error('no vetted address of that family')
			error.code = 'ENOTFOUND'
			callback(error, '', 0)
			return
		}
		if (options?.all === true) {
			callback(
				null,
				usable.map((a) => ({ address: a.address, family: a.family })),
			)
			return
		}
		callback(null, first.address, first.family)
	}
}

/** `api.example.com` is that host; `.example.com` is the domain and its subdomains. */
export function hostMatchesPolicy(hostname: string, allowedHosts: readonly string[]): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, '')
	return allowedHosts.some((entry) => {
		const allowed = entry.toLowerCase().replace(/\.$/, '')
		if (allowed.startsWith('.')) return host === allowed.slice(1) || host.endsWith(allowed)
		return host === allowed
	})
}

/**
 * Why a sandbox forbids this connection, or undefined when it does not.
 *
 * The connection is opened by the host process, outside the boundary, so a
 * sandbox's network rules do not bind it. If a turn runs under a sandbox that
 * isolates the network, letting the host connect would be a way out of that
 * isolation, so it is refused unless the sandbox's live policy names the host.
 * A sandbox that does not isolate the network says nothing about it, and the
 * connection is allowed, subject to the address check and to review.
 */
export function webSocketSandboxRefusal(
	sandbox: Sandbox | undefined,
	hostname: string,
): string | undefined {
	if (sandbox === undefined) return undefined
	if (!isolationOf(sandbox.environment).network) return undefined
	const allowed = sandbox.networkPolicy?.allowedHosts
	if (allowed !== undefined && hostMatchesPolicy(hostname, allowed)) return undefined
	return `A WebSocket monitor connects from the host, outside this turn's sandbox, which blocks the network. "${hostname}" is not on the sandbox's list of allowed hosts, so the connection was not opened. Allow the host in the sandbox's network policy, or watch the service from inside the sandbox with a command.`
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

/** Server-written text, made one short line before it goes into a notice. */
function oneLine(text: string): string {
	const line = Array.from(text, (character) => {
		const code = character.charCodeAt(0)
		return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : character
	})
		.join('')
		.replace(/\s+/g, ' ')
		.trim()
	return line.length <= CLOSE_REASON_MAX_CHARS
		? line
		: `${line.slice(0, CLOSE_REASON_MAX_CHARS)}...`
}

export const webSocketRejectedNotice = (status: number): string =>
	`[WebSocket upgrade rejected: HTTP ${status}]`
export const webSocketErrorNotice = (message: string): string =>
	`[WebSocket error: ${oneLine(message)}]`
export const webSocketClosedNotice = (code: number, reason: string): string => {
	const why = oneLine(reason)
	return why === '' ? `[WebSocket closed: ${code}]` : `[WebSocket closed: ${code} ${why}]`
}
export const webSocketDroppedNotice = (): string =>
	`[Dropped a frame larger than ${WEBSOCKET_MAX_PAYLOAD_BYTES} bytes; closing]`

// ---------------------------------------------------------------------------
// The connection, as something the registry can hold
// ---------------------------------------------------------------------------

export interface WebSocketSourceOptions {
	readonly target: MonitorWebSocketTarget
	readonly host: JobHost
}

function frameBytes(data: Buffer | ArrayBuffer | Buffer[]): number {
	if (Array.isArray(data)) return data.reduce((sum, part) => sum + part.length, 0)
	return data instanceof ArrayBuffer ? data.byteLength : data.length
}

/**
 * Open the connection and return it as a job's process.
 *
 * The socket library is loaded when the first monitor of this kind starts, so
 * a session that never watches a WebSocket never pays for it.
 */
export function connectWebSocketSource(options: WebSocketSourceOptions): JobSource {
	const { target, host } = options
	const stand = Object.assign(new EventEmitter(), {
		pid: undefined,
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
	})
	let socket: WebSocketClient | undefined
	let graceTimer: ReturnType<typeof setTimeout> | undefined
	// Set once somebody asked the connection to stop (a kill, the expiry, the
	// output rule). From then on the connection says nothing: the registry has
	// already told the model why the watch ended, and nothing follows that.
	let stopping = false
	let opened = false
	let rejected = false
	let oversize = false
	// The connection failed before it opened: the error notice was the last word.
	let failedToOpen = false
	let ended = false

	const write = (text: string): void => {
		if (stopping || ended) return
		stand.stdout.emit('data', text)
	}
	const end = (exitCode: number): void => {
		if (ended) return
		ended = true
		clearTimeout(graceTimer)
		stand.emit('close', exitCode, null)
	}

	void import('ws')
		.then(({ WebSocket }) => {
			if (stopping) {
				end(0)
				return
			}
			const client = new WebSocket(
				target.url,
				target.protocols && target.protocols.length > 0 ? [...target.protocols] : undefined,
				{
					maxPayload: WEBSOCKET_MAX_PAYLOAD_BYTES,
					// A redirect could lead to an address nobody checked.
					followRedirects: false,
					// A compressed frame inflates past the size cap before it is
					// measured; refusing the extension leaves every frame as sent.
					perMessageDeflate: false,
					handshakeTimeout: WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
					// Only the vetted addresses; see `pinnedLookup`.
					lookup: pinnedLookup(target.addresses),
				},
			)
			socket = client
			client.on('open', () => {
				opened = true
			})
			client.on('unexpected-response', (_request, response) => {
				if (stopping) return
				rejected = true
				response.resume()
				host.notice(webSocketRejectedNotice(response.statusCode ?? 0), { final: true })
				// With a listener for this event the library leaves the half-open
				// request to us.
				client.terminate()
			})
			client.on('error', (error: Error & { code?: string }) => {
				if (stopping || rejected || oversize) return
				if (error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
					// The library knows a frame was too big and not how big: it stops
					// reading at the length field.
					oversize = true
					host.notice(webSocketDroppedNotice(), { final: true })
					client.terminate()
					return
				}
				if (!opened) {
					// It never opened, so there is no close to report after this:
					// one notice says it failed, and it is the last.
					failedToOpen = true
					host.notice(webSocketErrorNotice(error.message), { final: true })
					return
				}
				host.notice(webSocketErrorNotice(error.message))
			})
			client.on('message', (data, isBinary) => {
				if (isBinary) {
					write(`[binary frame, ${frameBytes(data)} bytes]\n`)
					return
				}
				const text = Array.isArray(data)
					? Buffer.concat(data).toString('utf8')
					: Buffer.from(data as Buffer).toString('utf8')
				// Frames are not lines. A newline closes this one, so the next frame
				// starts a fresh line and a frame without one is not glued to it.
				write(text.endsWith('\n') ? text : `${text}\n`)
			})
			client.on('close', (code, reason) => {
				const why = reason.toString('utf8')
				if (!stopping && !rejected && !oversize && !failedToOpen) {
					host.notice(webSocketClosedNotice(code, why), { final: true })
					if (opened) host.connectionClosed(code, oneLine(why))
				}
				// A normal or going-away close is the stream ending; anything else,
				// and a connection that never opened, is a failure.
				end(opened && (code === 1000 || code === 1001 || code === 1005) ? 0 : 1)
			})
		})
		.catch((error: unknown) => {
			host.notice(webSocketErrorNotice(error instanceof Error ? error.message : String(error)), {
				final: true,
			})
			end(1)
		})

	return {
		child: stand,
		// Not a process, so the registry's group kill has nothing to signal; this
		// is how it is stopped. SIGTERM asks politely, SIGKILL (and the grace
		// running out) destroys the socket.
		kill(signal) {
			if (ended) return
			if (signal === 'SIGKILL') {
				stopping = true
				if (socket) socket.terminate()
				else end(0)
				return
			}
			if (stopping) return
			stopping = true
			if (!socket) return // the import resolves, sees `stopping`, and ends
			if (socket.readyState === socket.OPEN) {
				socket.close(1000)
				graceTimer = setTimeout(() => socket?.terminate(), WEBSOCKET_CLOSE_GRACE_MS)
				graceTimer.unref?.()
			} else {
				socket.terminate()
			}
		},
	}
}
