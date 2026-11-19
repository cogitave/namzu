import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { type Server, type Socket, connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runnerDir } from '../signin/launcher.js'
import { atomicWrite } from '../store.js'

/**
 * The runner's control channel: local only, no port. A Windows named pipe (remote clients rejected by the
 * pipe itself), elsewhere a Unix socket in a mode-700 folder. Newline-delimited JSON, four operations and
 * nothing else: `reload`, `status`, `stop`, `restart`. Every request carries a token Namzu keeps in the
 * runner folder (mode 600), so another account on the machine that can reach the pipe still cannot use it.
 */

export type CtlRequest =
	| { op: 'reload' }
	| { op: 'status' }
	| { op: 'stop' }
	| { op: 'restart'; id: string }

export type CtlResponse = { ok: boolean; error?: string; [k: string]: unknown }

export interface CtlHandlers {
	reload(): Promise<CtlResponse> | CtlResponse
	status(): Promise<CtlResponse> | CtlResponse
	stop(): Promise<CtlResponse> | CtlResponse
	restart(id: string): Promise<CtlResponse> | CtlResponse
}

const hash8 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8)

/** The address of the channel for a home: a named pipe on Windows, a socket path elsewhere. */
export function ctlAddress(root: string, platform: NodeJS.Platform = process.platform): string {
	if (platform === 'win32') {
		const who = process.env.USERNAME ?? ''
		return `\\\\.\\pipe\\namzu-runner-${hash8(`${root}|${who}`)}`
	}
	const direct = join(runnerDir(root), 'ctl.sock')
	// A Unix socket path has a short limit; past it the socket lives in a private per-user folder.
	if (Buffer.byteLength(direct) < 100) return direct
	const uid = typeof process.getuid === 'function' ? process.getuid() : 0
	return join(tmpdir(), `namzu-${uid}`, `runner-${hash8(root)}.sock`)
}

const tokenFile = (root: string): string => join(runnerDir(root), 'ctl.token')

function ensureToken(root: string): string {
	try {
		const t = readFileSync(tokenFile(root), 'utf8').trim()
		if (t) return t
	} catch {
		// make one
	}
	const t = randomBytes(32).toString('hex')
	atomicWrite(tokenFile(root), `${t}\n`, 0o600)
	return t
}

const MAX_LINE = 4096

export interface CtlServer {
	readonly address: string
	close(): Promise<void>
}

export async function startCtlServer(
	root: string,
	handlers: CtlHandlers,
	platform: NodeJS.Platform = process.platform,
): Promise<CtlServer> {
	mkdirSync(runnerDir(root), { recursive: true, mode: 0o700 })
	const address = ctlAddress(root, platform)
	if (platform !== 'win32') {
		const dir = join(address, '..')
		mkdirSync(dir, { recursive: true, mode: 0o700 })
		const st = statSync(dir)
		if (typeof process.getuid === 'function' && st.uid !== process.getuid())
			throw new Error('the runner socket folder belongs to another user')
		chmodSync(dir, 0o700)
		rmSync(address, { force: true })
	}
	const token = Buffer.from(ensureToken(root))
	const sockets = new Set<Socket>()
	const server: Server = createServer((sock) => {
		sockets.add(sock)
		sock.on('close', () => sockets.delete(sock))
		sock.on('error', () => {})
		let buf = ''
		sock.setEncoding('utf8')
		sock.on('data', (chunk: string) => {
			buf += chunk
			if (buf.length > MAX_LINE) {
				sock.destroy()
				return
			}
			const at = buf.indexOf('\n')
			if (at < 0) return
			const line = buf.slice(0, at)
			buf = buf.slice(at + 1)
			void answer(line).then((r) => {
				// `stop` is carried out only after its answer is on the wire, so the caller hears that it worked.
				const after = r.after as (() => void) | undefined
				const { after: _drop, ...reply } = r
				sock.end(`${JSON.stringify(reply)}\n`, () => after?.())
			})
		})
	})
	async function answer(line: string): Promise<CtlResponse> {
		let req: { auth?: unknown; op?: unknown; id?: unknown }
		try {
			req = JSON.parse(line)
		} catch {
			return { ok: false, error: 'bad-request' }
		}
		const given = Buffer.from(typeof req.auth === 'string' ? req.auth : '')
		if (given.length !== token.length || !timingSafeEqual(given, token))
			return { ok: false, error: 'not-allowed' }
		try {
			switch (req.op) {
				case 'reload':
					return await handlers.reload()
				case 'status':
					return await handlers.status()
				case 'stop':
					return { ok: true, after: () => void handlers.stop() }
				case 'restart':
					return typeof req.id === 'string' && /^[a-z0-9.-]+$/.test(req.id)
						? await handlers.restart(req.id)
						: { ok: false, error: 'bad-request' }
				default:
					return { ok: false, error: 'unknown-op' }
			}
		} catch (e) {
			return { ok: false, error: (e as Error).message }
		}
	}
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(address, () => {
			server.off('error', reject)
			resolve()
		})
	})
	if (platform !== 'win32') chmodSync(address, 0o600)
	return {
		address,
		close: () =>
			new Promise<void>((resolve) => {
				// A reply that is being written (the `stop` answer itself) is finished first: sockets are asked to
				// end, and only one that does not is destroyed after a moment.
				const lingering = [...sockets].map((sock) => {
					sock.end()
					const t = setTimeout(() => sock.destroy(), 1000)
					t.unref?.()
					return t
				})
				server.close(() => {
					for (const t of lingering) clearTimeout(t)
					if (platform !== 'win32') rmSync(address, { force: true })
					resolve()
				})
			}),
	}
}

/** One request to the runner; undefined when nobody answers (no runner, or it does not accept us). */
export function ctlRequest(
	root: string,
	req: CtlRequest,
	platform: NodeJS.Platform = process.platform,
): Promise<CtlResponse | undefined> {
	let token = ''
	try {
		token = readFileSync(tokenFile(root), 'utf8').trim()
	} catch {
		return Promise.resolve(undefined)
	}
	return new Promise((resolve) => {
		const sock = connect(ctlAddress(root, platform))
		let buf = ''
		let done = false
		const finish = (v: CtlResponse | undefined): void => {
			if (done) return
			done = true
			sock.destroy()
			resolve(v)
		}
		sock.setEncoding('utf8')
		sock.setTimeout(5000, () => finish(undefined))
		sock.on('error', () => finish(undefined))
		sock.on('connect', () => sock.write(`${JSON.stringify({ ...req, auth: token })}\n`))
		sock.on('data', (c: string) => {
			buf += c
		})
		sock.on('end', () => {
			try {
				finish(JSON.parse(buf.trim()) as CtlResponse)
			} catch {
				finish(undefined)
			}
		})
	})
}
