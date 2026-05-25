/**
 * The namzu daemon (`namzu serve`): a localhost HTTP service that tracks live
 * namzu sessions so an agent-view can list them and (later) attach across
 * terminals. This module is the foundation — a bearer-authed JSON API over a
 * loopback socket, advertised via the discovery file. Session hosting +
 * event/input proxying for true cross-terminal attach build on top.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
	type DaemonInfo,
	pidAlive,
	readDaemonInfo,
	removeDaemonInfo,
	writeDaemonInfo,
} from './discovery.js'
import { HostedSessionManager } from './hosted.js'
import { SessionRegistry } from './registry.js'

const HOST = '127.0.0.1'

export interface StartDaemonOptions {
	/** Port to bind; 0 (default) picks an ephemeral free port. */
	readonly port?: number
	/** Where status lines are written (stderr by default). */
	readonly log?: (line: string) => void
}

export interface RunningDaemon {
	readonly info: DaemonInfo
	readonly close: () => Promise<void>
}

/**
 * Start the daemon and bind it. Refuses to start if a healthy daemon is
 * already running (returns its info via the thrown error message). Resolves
 * once bound; the caller keeps the process alive.
 */
export async function startDaemon(opts: StartDaemonOptions = {}): Promise<RunningDaemon> {
	const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`))

	const existing = readDaemonInfo()
	if (existing && pidAlive(existing.pid) && existing.pid !== process.pid) {
		throw new Error(`namzu daemon already running (pid ${existing.pid}) at ${baseUrl(existing)}`)
	}

	const registry = new SessionRegistry()
	const hosted = new HostedSessionManager()
	const token = randomUUID()
	const version = readCliVersion()

	const server = createServer((req, res) => handle(req, res, { registry, hosted, token }))
	await listen(server, opts.port ?? 0)
	const addr = server.address()
	const port = typeof addr === 'object' && addr ? addr.port : 0

	const info: DaemonInfo = {
		pid: process.pid,
		host: HOST,
		port,
		token,
		version,
		startedAt: Date.now(),
	}
	writeDaemonInfo(info)
	log(`namzu daemon listening on ${baseUrl(info)} (pid ${process.pid})`)

	const close = async (): Promise<void> => {
		removeDaemonInfo()
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
	return { info, close }
}

function baseUrl(info: { host: string; port: number }): string {
	return `http://${info.host}:${info.port}`
}

function listen(server: Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, HOST, () => {
			server.removeListener('error', reject)
			resolve()
		})
	})
}

interface Deps {
	readonly registry: SessionRegistry
	readonly hosted: HostedSessionManager
	readonly token: string
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: Deps): Promise<void> {
	const { registry, hosted, token } = deps
	const url = new URL(req.url ?? '/', `http://${HOST}`)
	const path = url.pathname
	const method = req.method ?? 'GET'

	// Health is unauthenticated so liveness probes are trivial.
	if (path === '/health' && method === 'GET') {
		return json(res, 200, {
			ok: true,
			version: readCliVersion(),
			pid: process.pid,
			uptimeMs: Math.round(process.uptime() * 1000),
			sessions: registry.count(),
		})
	}

	// Everything else requires the bearer token from the discovery file.
	const auth = req.headers.authorization
	if (auth !== `Bearer ${token}`) {
		return json(res, 401, { error: 'unauthorized' })
	}

	// --- daemon-hosted agent sessions (attach) ---
	if (path === '/v1/hosted' && method === 'GET') {
		return json(res, 200, { sessions: hosted.list() })
	}
	if (path === '/v1/hosted' && method === 'POST') {
		const body = await readJson(req)
		if (!body || typeof body.cwd !== 'string') {
			return json(res, 400, { error: 'cwd is required' })
		}
		const v = hosted.create({
			cwd: body.cwd,
			title: typeof body.title === 'string' ? body.title : undefined,
		})
		return json(res, 201, v)
	}
	const hostedMsg = path.match(/^\/v1\/hosted\/([^/]+)\/message$/)
	if (hostedMsg && method === 'POST') {
		const id = hostedMsg[1] as string
		const body = await readJson(req)
		const text = typeof body?.text === 'string' ? body.text : ''
		if (!hosted.get(id)) return json(res, 404, { error: 'not found' })
		// Fire-and-forget: the turn streams into the log; the client polls events.
		void hosted.runMessage(id, text)
		return json(res, 202, { accepted: true })
	}
	const hostedEvents = path.match(/^\/v1\/hosted\/([^/]+)\/events$/)
	if (hostedEvents && method === 'GET') {
		const id = hostedEvents[1] as string
		if (!hosted.get(id)) return json(res, 404, { error: 'not found' })
		const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0
		return json(res, 200, hosted.eventsSince(id, since))
	}

	if (path === '/v1/sessions' && method === 'GET') {
		return json(res, 200, { sessions: registry.list() })
	}
	if (path === '/v1/sessions' && method === 'POST') {
		const body = await readJson(req)
		if (!body || typeof body.cwd !== 'string' || typeof body.pid !== 'number') {
			return json(res, 400, { error: 'cwd and pid are required' })
		}
		const rec = registry.register({
			cwd: body.cwd,
			pid: body.pid,
			title: typeof body.title === 'string' ? body.title : undefined,
			model: typeof body.model === 'string' ? body.model : null,
		})
		return json(res, 201, rec)
	}

	const sessionMatch = path.match(/^\/v1\/sessions\/([^/]+)$/)
	if (sessionMatch) {
		const id = sessionMatch[1] as string
		if (method === 'PUT') {
			const body = (await readJson(req)) ?? {}
			const rec = registry.update(id, {
				title: typeof body.title === 'string' ? body.title : undefined,
				model: typeof body.model === 'string' ? body.model : undefined,
				state: typeof body.state === 'string' ? (body.state as never) : undefined,
			})
			return rec ? json(res, 200, rec) : json(res, 404, { error: 'not found' })
		}
		if (method === 'DELETE') {
			return json(res, 200, { removed: registry.remove(id) })
		}
	}

	return json(res, 404, { error: 'not found' })
}

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body)
	res.writeHead(status, { 'content-type': 'application/json' })
	res.end(payload)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
	const chunks: Buffer[] = []
	for await (const c of req) chunks.push(c as Buffer)
	if (chunks.length === 0) return null
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
		return typeof parsed === 'object' && parsed !== null
			? (parsed as Record<string, unknown>)
			: null
	} catch {
		return null
	}
}

function readCliVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url))
		// dist/daemon/server.js → ../../package.json; src/daemon/server.ts → same depth.
		const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as {
			version?: unknown
		}
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
	} catch {
		return '0.0.0'
	}
}
