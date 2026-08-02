import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect } from 'node:net'
import type { Duplex } from 'node:stream'

import { isHostAllowed, splitAuthority } from './allowlist.js'

/**
 * The network boundary a sandbox's egress policy is enforced at.
 *
 * Until this existed, an egress policy could be *declared* and only two of
 * its four shapes could be honoured anywhere: the container backend refuses
 * a host allowlist outright because it has no proxy to filter through, and
 * only the microVM backend forwards one. `deny-all` and `allow-all` are the
 * whole spectrum a container-tier sandbox could express — all or nothing.
 *
 * It also settles where credentials live. Any token the agent needs in
 * order to reach an allowed host used to have to be inside the sandbox, in
 * the environment, readable by the untrusted code it is meant to be
 * isolated from — via `/proc/self/environ`, or via a prompt injection that
 * exfiltrates it over the very egress the policy permits. Here the token
 * never enters the sandbox: a placeholder does, and the real value is
 * stamped on at this boundary.
 */

/** A credential the proxy stamps on, and the host it may be sent to. */
export interface BrokeredCredential {
	/**
	 * Host this credential is for. Same matching rules as the allowlist,
	 * so `.example.com` covers subdomains.
	 *
	 * Scoped per host on purpose: a credential attached to every request
	 * is a credential handed to whichever host the agent was talked into
	 * contacting.
	 */
	readonly host: string
	/** Header to set, e.g. `authorization`. */
	readonly header: string
	/** The real value. Never leaves this process. */
	readonly value: string
}

export interface EgressProxyOptions {
	/** Resolved at request time, so a rotating allowlist is honoured. */
	readonly allowedHosts: () => Promise<readonly string[]>
	readonly credentials?: readonly BrokeredCredential[]
	/**
	 * Rewrite a plain-HTTP request to HTTPS upstream.
	 *
	 * This is what makes brokering work at all. A credential cannot be
	 * injected into a CONNECT tunnel — the bytes are already encrypted by
	 * the time they reach the proxy, and reading them would mean
	 * terminating TLS with a CA the sandbox trusts, which is a far larger
	 * and far more dangerous thing to build. So the sandbox speaks plain
	 * HTTP to the proxy, and the proxy speaks HTTPS to the world.
	 *
	 * Default `true`. Turn it off only for a genuinely plaintext upstream.
	 */
	readonly upgradeToHttps?: boolean
	readonly onDenied?: (host: string, reason: string) => void
}

export interface RunningEgressProxy {
	readonly port: number
	/** `http://127.0.0.1:<port>` — what a sandbox sets `HTTP_PROXY` to. */
	readonly url: string
	/** Swap the allowlist on a live proxy. See `setNetworkPolicy`. */
	setAllowedHosts(resolve: () => Promise<readonly string[]>): void
	close(): Promise<void>
}

const DENIED_STATUS = 403

export class EgressProxy {
	private resolveAllowed: () => Promise<readonly string[]>
	private readonly credentials: readonly BrokeredCredential[]
	private readonly upgradeToHttps: boolean
	private readonly onDenied: ((host: string, reason: string) => void) | undefined
	/** See the loop guard in `listen`. */
	private selfPort: number | undefined

	constructor(options: EgressProxyOptions) {
		this.resolveAllowed = options.allowedHosts
		this.credentials = options.credentials ?? []
		this.upgradeToHttps = options.upgradeToHttps ?? true
		this.onDenied = options.onDenied
	}

	async listen(port = 0): Promise<RunningEgressProxy> {
		const server = createServer((req, res) => {
			void this.handleRequest(req, res)
		})
		server.on('connect', (req, socket, head) => {
			void this.handleConnect(req, socket, head)
		})
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject)
			// Loopback only. A proxy that holds real credentials and binds
			// every interface is reachable by anything on the network, which
			// is the opposite of what it exists for.
			server.listen(port, '127.0.0.1', () => {
				server.off('error', reject)
				resolve()
			})
		})

		const address = server.address()
		const boundPort = typeof address === 'object' && address !== null ? address.port : port
		// Refuse to forward to ourselves. A client that sends its `Host` as
		// the proxy's own address — which is what a library that rewrites
		// `Host` on a proxied request produces — would otherwise make the
		// proxy call itself forever, holding a socket per hop until the
		// process runs out. Found by a test that hung rather than failed,
		// which is the shape this failure takes in production too.
		this.selfPort = boundPort

		return {
			port: boundPort,
			url: `http://127.0.0.1:${boundPort}`,
			setAllowedHosts: (resolve) => {
				this.resolveAllowed = resolve
			},
			close: () =>
				new Promise<void>((resolve) => {
					server.close(() => resolve())
				}),
		}
	}

	private async allowed(host: string): Promise<boolean> {
		try {
			return isHostAllowed(host, await this.resolveAllowed())
		} catch {
			// A resolver that throws is a policy that could not be read.
			// Denying is the only safe reading: an allowlist that fails open
			// is not an allowlist.
			return false
		}
	}

	private deny(host: string, reason: string): void {
		this.onDenied?.(host, reason)
	}

	/** Plain HTTP. The only path where a credential can be stamped on. */
	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const target = parseTarget(req)
		if (!target) {
			res.writeHead(400, { 'content-type': 'text/plain' })
			res.end('Malformed proxy request: no absolute URL and no Host header.\n')
			return
		}

		if (this.isSelf(target.host, target.port)) {
			res.writeHead(400, { 'content-type': 'text/plain' })
			res.end(
				'Refusing to proxy a request addressed to the proxy itself; forwarding it would loop until the process ran out of sockets. Send an absolute URL in the request line, which is what a proxied client does.\n',
			)
			return
		}

		if (!(await this.allowed(target.host))) {
			this.deny(target.host, 'not on the egress allowlist')
			res.writeHead(DENIED_STATUS, { 'content-type': 'text/plain' })
			// Named, not a generic refusal: an agent that cannot tell "this
			// host is not permitted" from "the network is down" will retry
			// forever, and a human debugging it has nothing to go on.
			res.end(`Egress denied: ${target.host} is not on this sandbox's allowlist.\n`)
			return
		}

		const headers = { ...req.headers }
		// The proxy re-issues the request, so hop-by-hop headers about the
		// hop that just ended must not be forwarded.
		for (const hop of ['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive']) {
			delete headers[hop]
		}

		const credential = this.credentialFor(target.host)
		if (credential) {
			headers[credential.header.toLowerCase()] = credential.value
		}

		const secure = this.upgradeToHttps || target.protocol === 'https:'
		const send = secure ? httpsRequest : httpRequest
		const upstream = send(
			{
				protocol: secure ? 'https:' : 'http:',
				host: target.host,
				port: target.port ?? (secure ? 443 : 80),
				method: req.method,
				path: target.path,
				headers,
			},
			(response) => {
				res.writeHead(response.statusCode ?? 502, response.headers)
				response.pipe(res)
			},
		)

		upstream.on('error', (err) => {
			if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
			res.end(`Upstream request failed: ${err.message}\n`)
		})
		req.pipe(upstream)
	}

	/**
	 * HTTPS, tunnelled.
	 *
	 * The allowlist is enforceable here because the CONNECT target names
	 * the host in clear text. Credential brokering is NOT: the tunnel is
	 * opaque, and injecting into it would mean terminating TLS with a CA
	 * the sandbox trusts — which would let this process read every byte the
	 * agent sends anywhere, a strictly larger risk than the one being
	 * mitigated. A workload that needs brokering speaks plain HTTP to the
	 * proxy and lets it upgrade upstream.
	 */
	private async handleConnect(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		const { host, port } = splitAuthority(req.url ?? '')

		if (!(await this.allowed(host))) {
			this.deny(host, 'not on the egress allowlist')
			socket.write(
				`HTTP/1.1 ${DENIED_STATUS} Forbidden\r\nContent-Type: text/plain\r\n\r\nEgress denied: ${host} is not on this sandbox's allowlist.\n`,
			)
			socket.end()
			return
		}

		const upstream = netConnect(port ?? 443, host, () => {
			socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
			if (head.length > 0) upstream.write(head)
			upstream.pipe(socket)
			socket.pipe(upstream)
		})

		upstream.on('error', () => {
			socket.end()
		})
		socket.on('error', () => {
			upstream.destroy()
		})
	}

	/** Whether a target names this proxy. See the loop guard in `listen`. */
	private isSelf(host: string, port?: number): boolean {
		if (port === undefined || port !== this.selfPort) return false
		return host === '127.0.0.1' || host === 'localhost' || host === '::1'
	}

	private credentialFor(host: string): BrokeredCredential | undefined {
		return this.credentials.find((c) => isHostAllowed(host, [c.host]))
	}
}

interface ProxyTarget {
	readonly host: string
	readonly port?: number
	readonly path: string
	readonly protocol: string
}

/**
 * Read the target from a proxied request.
 *
 * A proxy receives an absolute URL in the request line; a client that
 * forgot it still sends `Host`, and honouring that is what makes a plain
 * `fetch` through `HTTP_PROXY` work.
 */
function parseTarget(req: IncomingMessage): ProxyTarget | null {
	const raw = req.url ?? ''

	if (raw.startsWith('http://') || raw.startsWith('https://')) {
		const url = new URL(raw)
		return {
			host: url.hostname,
			...(url.port ? { port: Number(url.port) } : {}),
			path: `${url.pathname}${url.search}`,
			protocol: url.protocol,
		}
	}

	const hostHeader = req.headers.host
	if (!hostHeader) return null
	const { host, port } = splitAuthority(hostHeader)
	return {
		host,
		...(port !== undefined ? { port } : {}),
		path: raw || '/',
		protocol: 'http:',
	}
}
