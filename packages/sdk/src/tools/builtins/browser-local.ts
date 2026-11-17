/**
 * Opening a page the agent wrote.
 *
 * The browser tools take web addresses, and a `file:` address is not one the
 * browser is ever handed: a page loaded from `file:` can be steered at other
 * local addresses, and Chromium treats every `file:` document as its own
 * origin, so neither the site rules nor the host's origin check mean anything
 * for it. A page the agent wrote is opened through a door the tool owns
 * instead:
 *
 * - the model names a path (relative, absolute, or a `file:` URL, Windows
 *   forms included);
 * - the tool resolves it to a real file inside the session's work folder, a
 *   folder added to the session, or Namzu's scratch folder, and refuses
 *   everything else with the reason;
 * - a read-only server bound to 127.0.0.1 on a random port serves that one
 *   root under a random token, and the browser is given the `http:` address
 *   of the file there.
 *
 * Because the page lives on a real `http:` origin, relative CSS, images and
 * scripts load, screenshots and clicks work as on any page, and the host's
 * site rules and origin check apply unchanged. Because the server resolves
 * each request to a real path and serves it only when that path is inside the
 * root, a page cannot read anything else on the disk through it, however it
 * spells the request.
 */

import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { privateTempRootPath } from '../../utils/temp.js'

// ---------------------------------------------------------------------------
// Reading what the model wrote
// ---------------------------------------------------------------------------

/** A path the model named, before anything on disk has been looked at. */
export type LocalPageReading =
	| { readonly ok: true; readonly path: string; readonly suffix: string }
	| { readonly ok: false; readonly reason: string }

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/

/** `C:\x` and `C:/x`. */
export function isWindowsDrivePath(path: string): boolean {
	return WINDOWS_DRIVE.test(path)
}

/**
 * Is `raw` a local page the model named rather than a web address, and if so
 * which path does it name? `undefined` means it is not local (an `http:` or
 * `https:` address, `about:blank`, any other scheme): the caller treats it as
 * a web address.
 *
 * Local forms: a plain relative or absolute path, a Windows path (`C:\x`,
 * `C:/x`), and a `file:` URL (`file:///home/a/x.html`, `file:///C:/x.html`,
 * `file://localhost/x.html`, `file:C:/x.html`). A `file:` URL's query and
 * fragment come back as `suffix`, so `x.html#top` still opens at `#top`.
 *
 * Pure: reads nothing from the disk and does not depend on the platform.
 */
export function readLocalPageReference(raw: string): LocalPageReading | undefined {
	if (typeof raw !== 'string') return undefined
	const text = raw.trim()
	if (text === '' || text.includes('\0')) return undefined

	if (/^file:/i.test(text)) {
		let url: URL
		try {
			url = new URL(text)
		} catch {
			return { ok: false, reason: 'the file: address could not be read' }
		}
		if (url.hostname !== '' && url.hostname.toLowerCase() !== 'localhost') {
			return {
				ok: false,
				reason: `file://${url.hostname}/... names another machine; only a file in this session's folders can be opened`,
			}
		}
		let path: string
		try {
			path = decodeURIComponent(url.pathname)
		} catch {
			return { ok: false, reason: 'the file: address has a broken percent-escape' }
		}
		if (path.includes('\0')) return undefined
		// `/C:/x` is how a URL spells `C:\x`.
		if (/^\/[A-Za-z]:(?:[\\/]|$)/.test(path)) path = path.slice(1)
		return { ok: true, path, suffix: `${url.search}${url.hash}` }
	}
	if (isWindowsDrivePath(text)) return { ok: true, path: text, suffix: '' }
	if (/^(?:\\\\|\/\/)/.test(text)) {
		return {
			ok: false,
			reason: 'a network share (\\\\host\\...) is not a folder of this session',
		}
	}
	if (SCHEME.test(text)) return undefined
	return { ok: true, path: text, suffix: '' }
}

// ---------------------------------------------------------------------------
// What is never served
// ---------------------------------------------------------------------------

/** Folder names no page is served from, at any depth. */
const SECRET_FOLDERS = new Set(['.git', '.ssh', '.gnupg', '.aws', '.namzu'])

/** File names (lowercased) that hold credentials. */
const SECRET_FILES = new Set([
	'.npmrc',
	'.netrc',
	'.pypirc',
	'.git-credentials',
	'.htpasswd',
	'credentials.json',
	'secrets.json',
	'service-account.json',
])

const SECRET_NAME_PATTERNS: readonly RegExp[] = [
	/^\.env(?:\..+)?$/i,
	/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
	/\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i,
]

const ENV_TEMPLATES = /^\.env\.(?:example|sample|template|dist)$/i

/**
 * The reason a path is never served, or `undefined`. `segments` are the
 * path's parts below its root.
 *
 * This is the floor. A host that carries read rules (`ToolContext.readDenied`)
 * adds those on top; they are the operator's own list and the tool reuses it
 * rather than keeping a second one.
 */
export function secretPathReason(segments: readonly string[]): string | undefined {
	for (const segment of segments) {
		const lower = segment.toLowerCase()
		if (lower === '.git') return 'it is inside a .git folder'
		if (SECRET_FOLDERS.has(lower)) return `it is inside a ${segment} folder, which holds secrets`
	}
	const name = (segments[segments.length - 1] ?? '').toLowerCase()
	if (ENV_TEMPLATES.test(name)) return undefined
	if (SECRET_FILES.has(name) || SECRET_NAME_PATTERNS.some((p) => p.test(name))) {
		return `${segments[segments.length - 1]} looks like a secret file`
	}
	return undefined
}

// ---------------------------------------------------------------------------
// Resolving a path to a file inside an allowed root
// ---------------------------------------------------------------------------

/** What the resolver needs of a tool call. */
export interface LocalPageContext {
	readonly workingDirectory: string
	readonly additionalDirectories?: readonly string[] | undefined
	readonly readDenied?: ((absolutePath: string) => boolean) | undefined
}

/** A file inside an allowed root, by real path. */
export interface LocalPageTarget {
	/** Real path of the root that holds the file. */
	readonly root: string
	/** Segments below the root, of the file's real path. */
	readonly segments: readonly string[]
}

export class LocalPageRefusal extends Error {
	override readonly name = 'LocalPageRefusal'
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path)
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function segmentsBelow(root: string, path: string): string[] {
	const rel = relative(root, path)
	return rel === '' ? [] : rel.split(sep)
}

/** The folders a local page may come from, in the order they are tried. */
export function localPageRoots(context: LocalPageContext): string[] {
	const roots = [context.workingDirectory, ...(context.additionalDirectories ?? [])]
	try {
		roots.push(privateTempRootPath())
	} catch {
		// No scratch folder is configured here; the work folder still is.
	}
	return roots
}

function describeAllowed(context: LocalPageContext): string {
	const extra = context.additionalDirectories ?? []
	return `Local pages open from this session's work folder (${resolve(context.workingDirectory)})${
		extra.length > 0 ? `, the folders added to it (${extra.map((d) => resolve(d)).join(', ')})` : ''
	} and Namzu's scratch folder.`
}

/**
 * The real file `reading` names, if it is inside an allowed root and is not
 * one that is never served. Refuses with a {@link LocalPageRefusal} whose
 * message says why and what IS allowed.
 *
 * Each root is resolved to its real path first and the file's real path is
 * compared against those, so a link inside the folder that leads out of it
 * is outside, and a `..` is gone before the comparison.
 */
export async function resolveLocalPage(
	reading: { readonly path: string },
	context: LocalPageContext,
	platform: NodeJS.Platform = process.platform,
): Promise<LocalPageTarget> {
	const allowed = describeAllowed(context)
	if (isWindowsDrivePath(reading.path) && platform !== 'win32') {
		throw new LocalPageRefusal(
			`${reading.path} is a Windows path and this session runs on ${platform}. Give the path the way this machine writes it. ${allowed}`,
		)
	}
	const lexical = resolve(context.workingDirectory, reading.path)

	let target: string
	try {
		target = await realpath(lexical)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new LocalPageRefusal(
				`There is no file at ${lexical}. If you meant a website, give its full https:// address; otherwise write the page first. ${allowed}`,
			)
		}
		throw new LocalPageRefusal(`${lexical} could not be read (${errorCode(error)}). ${allowed}`)
	}

	const realRoots: string[] = []
	for (const root of localPageRoots(context)) {
		try {
			realRoots.push(await realpath(root))
		} catch {
			// A root that does not exist holds nothing.
		}
	}
	const root = realRoots.find((candidate) => isInside(candidate, target))
	if (root === undefined) {
		const linked = realRoots.some((candidate) => isInside(candidate, resolve(lexical)))
		throw new LocalPageRefusal(
			linked
				? `${lexical} is a link that leads outside the allowed folders, to ${target}, so it is not opened. ${allowed}`
				: `${lexical} is outside the folders local pages open from. ${allowed}`,
		)
	}

	let file = target
	let info = await stat(file)
	if (info.isDirectory()) {
		file = join(file, 'index.html')
		try {
			file = await realpath(file)
			info = await stat(file)
		} catch {
			throw new LocalPageRefusal(
				`${lexical} is a folder with no index.html; folders are never listed. Name the page file. ${allowed}`,
			)
		}
		if (!isInside(root, file)) {
			throw new LocalPageRefusal(`${lexical}/index.html leads outside the allowed folders.`)
		}
	}
	if (!info.isFile()) throw new LocalPageRefusal(`${lexical} is not a file.`)

	const segments = segmentsBelow(root, file)
	const secret = secretPathReason(segments)
	// The lexical spelling too: a link named `site.html` that points at `.env`.
	// Taken below the root the spelling sits in, so a root that itself lives
	// under a folder such as .namzu does not refuse every page in it.
	const lexicalRoot = localPageRoots(context)
		.map((candidate) => resolve(candidate))
		.find((candidate) => isInside(candidate, lexical))
	const lexicalSecret =
		lexicalRoot === undefined ? undefined : secretPathReason(segmentsBelow(lexicalRoot, lexical))
	const reason = secret ?? lexicalSecret
	if (reason !== undefined) {
		throw new LocalPageRefusal(`${lexical} is not opened: ${reason}.`)
	}
	if (context.readDenied?.(file) === true || context.readDenied?.(lexical) === true) {
		throw new LocalPageRefusal(`${lexical} is not opened: this session's read rules deny it.`)
	}
	return { root, segments }
}

function errorCode(error: unknown): string {
	return (error as NodeJS.ErrnoException)?.code ?? 'unknown error'
}

// ---------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	'.html': 'text/html; charset=utf-8',
	'.htm': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.md': 'text/plain; charset=utf-8',
	'.csv': 'text/csv; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.wasm': 'application/wasm',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.pdf': 'application/pdf',
}

interface RootServer {
	readonly server: Server
	readonly token: string
	readonly origin: string
}

/**
 * Read-only static servers, one per root, owned by one browser tool set.
 *
 * Each is bound to 127.0.0.1 on a random port and answers only under
 * `/<token>/`, with a `Host` that is its own address (a page on another
 * origin cannot reach it by rebinding a name). A request is resolved to a
 * real path and served only when that path is a file inside the real root and
 * passes {@link secretPathReason} and the session's read rules; anything else
 * is a 404 or 403. Nothing lists a directory. The servers do not keep the
 * process alive, and {@link close} stops them.
 */
export class LocalPageServers {
	private readonly servers = new Map<string, Promise<RootServer>>()
	private denied: ((absolutePath: string) => boolean) | undefined

	/**
	 * The `http:` address on which `target` is served, starting the root's
	 * server if needed. `denied` is the session's read rules, as of this call.
	 */
	async urlFor(
		target: LocalPageTarget,
		suffix = '',
		denied?: (absolutePath: string) => boolean,
	): Promise<string> {
		this.denied = denied
		let started = this.servers.get(target.root)
		if (!started) {
			started = this.start(target.root)
			this.servers.set(target.root, started)
			started.catch(() => this.servers.delete(target.root))
		}
		const { token, origin } = await started
		const path = target.segments.map((segment) => encodeURIComponent(segment)).join('/')
		return `${origin}/${token}/${path}${suffix}`
	}

	/** Whether a server is up. */
	get running(): boolean {
		return this.servers.size > 0
	}

	/** Stop every server and drop its connections. Safe to call twice. */
	async close(): Promise<void> {
		const all = [...this.servers.values()]
		this.servers.clear()
		await Promise.all(
			all.map(async (started) => {
				try {
					const { server } = await started
					await new Promise<void>((done) => {
						server.close(() => done())
						server.closeAllConnections()
					})
				} catch {
					// It never started.
				}
			}),
		)
	}

	private async start(root: string): Promise<RootServer> {
		const token = randomBytes(24).toString('base64url')
		const server = createServer((req, res) => {
			this.handle(root, token, server, req, res).catch(() => {
				if (!res.headersSent) respond(res, 500)
				else res.destroy()
			})
		})
		await new Promise<void>((ok, fail) => {
			server.once('error', fail)
			server.listen(0, '127.0.0.1', () => {
				server.off('error', fail)
				ok()
			})
		})
		// A page the model forgot about must not keep the process alive.
		server.unref()
		const { port } = server.address() as AddressInfo
		return { server, token, origin: `http://127.0.0.1:${port}` }
	}

	private async handle(
		root: string,
		token: string,
		server: Server,
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const { port } = server.address() as AddressInfo
		if (req.headers.host !== `127.0.0.1:${port}`) return respond(res, 403)
		if (req.method !== 'GET' && req.method !== 'HEAD') return respond(res, 405)

		let pathname: string
		try {
			pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
		} catch {
			return respond(res, 400)
		}
		const prefix = `/${token}/`
		if (!pathname.startsWith(prefix)) return respond(res, 404)
		const parts = pathname.slice(prefix.length).split('/')
		const segments: string[] = []
		try {
			for (const part of parts) segments.push(decodeURIComponent(part))
		} catch {
			return respond(res, 400)
		}
		if (segments[segments.length - 1] === '') segments.pop()
		for (const segment of segments) {
			if (
				segment === '' ||
				segment === '.' ||
				segment === '..' ||
				segment.includes('\0') ||
				segment.includes('/') ||
				segment.includes('\\') ||
				/^[A-Za-z]:/.test(segment)
			)
				return respond(res, 400)
		}

		let file = join(root, ...segments)
		try {
			file = await realpath(file)
			if (!isInside(root, file)) return respond(res, 403)
			let info = await stat(file)
			if (info.isDirectory()) {
				file = await realpath(join(file, 'index.html'))
				if (!isInside(root, file)) return respond(res, 403)
				info = await stat(file)
			}
			if (!info.isFile()) return respond(res, 404)
			const real = segmentsBelow(root, file)
			if (secretPathReason(real) !== undefined || secretPathReason(segments) !== undefined)
				return respond(res, 403)
			if (this.denied?.(file) === true) return respond(res, 403)
			res.writeHead(200, {
				'Content-Type':
					CONTENT_TYPES[extname(basename(file)).toLowerCase()] ?? 'application/octet-stream',
				'Content-Length': info.size,
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff',
				'Cross-Origin-Resource-Policy': 'same-origin',
			})
			if (req.method === 'HEAD') return void res.end()
			createReadStream(file)
				.on('error', () => res.destroy())
				.pipe(res)
		} catch {
			respond(res, 404)
		}
	}
}

function respond(res: ServerResponse, status: number): void {
	res.writeHead(status, {
		'Content-Type': 'text/plain; charset=utf-8',
		'Cache-Control': 'no-store',
	})
	res.end(status === 403 ? 'Not served.' : status === 404 ? 'Not found.' : 'Refused.')
}
