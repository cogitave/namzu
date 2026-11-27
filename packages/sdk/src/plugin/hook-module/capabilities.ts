import { type ChildProcess, spawn } from 'node:child_process'
import {
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { Logger } from '../../utils/logger.js'

/** The most one read, one output stream or one answer body may hold. */
export const MAX_CAPABILITY_BYTES = 4 * 1024 * 1024
/** The most the module's store may hold, as JSON. */
export const MAX_STORE_BYTES = 1024 * 1024
export const DEFAULT_PROCESS_TIMEOUT_MS = 30_000
export const MAX_PROCESS_TIMEOUT_MS = 10 * 60_000
export const HTTP_TIMEOUT_MS = 30_000
/** The file the module's store is kept in, inside the plugin's data folder. */
export const STORE_FILE = 'hook-module-store.json'

export interface CapabilityBridgeOptions {
	/** The plugin's own folder. */
	readonly root: string
	/** The folder kept for the plugin's data; without it `$.store` throws. */
	readonly dataDir?: string
	/** The project folder. A relative path and a child's folder are read from it. */
	readonly projectDir: string
	/** The variables the scan found named by literal; `$.env.get` answers no other. */
	readonly envNames: readonly string[]
	/** The environment those variables are read from, and a child inherits. Default `process.env`. */
	readonly environment?: Readonly<Record<string, string | undefined>>
	readonly log: Logger
	readonly pluginName: string
	/** The web fetch. Default the global one. */
	readonly fetch?: typeof fetch
}

export interface CapabilityBridge {
	/** Answer one call on `$`. A throw is the call's rejection. */
	call(noun: string, method: string, args: readonly unknown[]): Promise<unknown>
	/** End every program a module started that is still running. */
	endProcesses(): void
}

/** What a program a module starts inherits of the host's environment, besides names the module reads. */
const CHILD_ENVIRONMENT = [
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'SHELL',
	'LANG',
	'LANGUAGE',
	'TZ',
	'TERM',
	'TMPDIR',
	'TEMP',
	'TMP',
	'SystemRoot',
	'SYSTEMROOT',
	'USERPROFILE',
	'APPDATA',
	'LOCALAPPDATA',
	'PATHEXT',
	'COMSPEC',
]

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function within(root: string, path: string): boolean {
	const rel = relative(root, path)
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function realOrSelf(path: string): string {
	try {
		return realpathSync(path)
	} catch {
		return resolve(path)
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * What a module may do beyond computing, answered by the host. Every call is
 * checked here and not in the worker: a path is resolved through links before
 * it is compared with the two folders a module may read, a command is an
 * argument list and never a shell line, and a variable is answered only when
 * the scan saw its name written out.
 */
export function createCapabilityBridge(options: CapabilityBridgeOptions): CapabilityBridge {
	const roots = [realOrSelf(options.root), realOrSelf(options.projectDir)]
	const project = resolve(options.projectDir)
	const environment = options.environment ?? process.env
	const fetchImpl = options.fetch ?? fetch
	const children = new Set<ChildProcess>()

	/** The path a read may open: lexically and really inside the plugin or the project. */
	const readable = (path: unknown, missingOk = false): { path: string; exists: boolean } => {
		if (typeof path !== 'string' || path === '' || path.includes('\0')) {
			throw new Error('a path is a non-empty string')
		}
		const absolute = isAbsolute(path) ? resolve(path) : resolve(project, path)
		const lexical = [resolve(options.root), project]
		if (
			!lexical.some((root) => within(root, absolute)) &&
			!roots.some((root) => within(root, absolute))
		) {
			throw new Error(`${path} is outside the plugin and the project folders`)
		}
		let real: string
		try {
			real = realpathSync(absolute)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT' && missingOk) {
				return { path: absolute, exists: false }
			}
			throw new Error(`${path}: ${errorText(error)}`)
		}
		if (!roots.some((root) => within(root, real))) {
			throw new Error(`${path} leads outside the plugin and the project folders through a link`)
		}
		return { path: real, exists: true }
	}

	const kindOf = (stats: { isFile(): boolean; isDirectory(): boolean }):
		| 'file'
		| 'dir'
		| 'other' => (stats.isFile() ? 'file' : stats.isDirectory() ? 'dir' : 'other')

	const fs = {
		read(args: readonly unknown[]): unknown {
			const [path, init] = args
			const { path: real } = readable(path)
			const spec = isRecord(init) ? init : {}
			const as = spec.as === undefined ? 'text' : spec.as
			if (as !== 'text' && as !== 'bytes') throw new Error('as is "text" or "bytes"')
			const offset = spec.offset === undefined ? 0 : spec.offset
			if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
				throw new Error('offset is a whole number of bytes')
			}
			const stats = statSync(real)
			if (!stats.isFile()) throw new Error(`${String(path)} is not a regular file`)
			const available = Math.max(0, stats.size - offset)
			const wanted = spec.length === undefined ? available : spec.length
			if (typeof wanted !== 'number' || !Number.isInteger(wanted) || wanted < 0) {
				throw new Error('length is a whole number of bytes')
			}
			if (
				wanted > MAX_CAPABILITY_BYTES ||
				(spec.length === undefined && available > MAX_CAPABILITY_BYTES)
			) {
				throw new Error(
					`the read is over ${MAX_CAPABILITY_BYTES / 1024 / 1024} MiB; read it in ranges`,
				)
			}
			const count = Math.min(wanted, available)
			const buffer = Buffer.alloc(count)
			if (count > 0) {
				const handle = openSync(real, 'r')
				try {
					readSync(handle, buffer, 0, count, offset)
				} finally {
					closeSync(handle)
				}
			}
			return as === 'bytes' ? { base64: buffer.toString('base64') } : buffer.toString('utf8')
		},
		exists(args: readonly unknown[]): boolean {
			return readable(args[0], true).exists
		},
		stat(args: readonly unknown[]): unknown {
			const { path: real } = readable(args[0])
			const stats = statSync(real)
			const link = lstatSync(
				resolve(isAbsolute(String(args[0])) ? String(args[0]) : join(project, String(args[0]))),
			).isSymbolicLink()
			const wantsReal = isRecord(args[1]) && args[1].resolve === true
			return {
				kind: kindOf(stats),
				size: stats.isFile() ? stats.size : 0,
				mtimeMs: stats.mtimeMs,
				isLink: link,
				...(wantsReal ? { realPath: real } : {}),
			}
		},
		list(args: readonly unknown[]): unknown {
			const { path: real } = readable(args[0] === undefined ? '.' : args[0])
			return readdirSync(real, { withFileTypes: true }).map((entry) => {
				const full = join(real, entry.name)
				let size = 0
				let mtimeMs = 0
				try {
					const stats = lstatSync(full)
					if (stats.isFile()) {
						size = stats.size
						mtimeMs = stats.mtimeMs
					}
				} catch {
					// An entry that vanished is listed with no size.
				}
				return {
					name: entry.name,
					kind: entry.isSymbolicLink()
						? 'other'
						: entry.isFile()
							? 'file'
							: entry.isDirectory()
								? 'dir'
								: 'other',
					size,
					mtimeMs,
					isLink: entry.isSymbolicLink(),
				}
			})
		},
	}

	const storePath = (): string => {
		if (options.dataDir === undefined) {
			throw new Error('this plugin has no data folder, so $.store has nowhere to keep anything')
		}
		return join(options.dataDir, STORE_FILE)
	}
	const readStore = (): Record<string, unknown> => {
		const path = storePath()
		let text: string
		try {
			text = readFileSync(path, 'utf8')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
			throw error
		}
		const parsed: unknown = JSON.parse(text)
		return isRecord(parsed) ? parsed : {}
	}
	const writeStore = (value: Record<string, unknown>): void => {
		const text = JSON.stringify(value)
		if (Buffer.byteLength(text) > MAX_STORE_BYTES) {
			throw new Error(`the store would be over ${MAX_STORE_BYTES / 1024 / 1024} MiB`)
		}
		const path = storePath()
		mkdirSync(options.dataDir as string, { recursive: true, mode: 0o700 })
		const temporary = `${path}.${process.pid}.tmp`
		writeFileSync(temporary, text, { mode: 0o600 })
		renameSync(temporary, path)
	}
	const storeKey = (key: unknown): string => {
		if (typeof key !== 'string' || key === '' || key.length > 256) {
			throw new Error('a store key is a string of 1 to 256 characters')
		}
		return key
	}
	const store = {
		get(args: readonly unknown[]): unknown {
			return readStore()[storeKey(args[0])]
		},
		set(args: readonly unknown[]): void {
			const key = storeKey(args[0])
			if (args[1] === undefined) throw new Error('a stored value is JSON, not undefined')
			const all = readStore()
			all[key] = args[1]
			writeStore(all)
		},
		delete(args: readonly unknown[]): void {
			const key = storeKey(args[0])
			const all = readStore()
			delete all[key]
			writeStore(all)
		},
		keys(): string[] {
			return Object.keys(readStore())
		},
	}

	const run = (args: readonly unknown[]): Promise<unknown> => {
		const [argv, init] = args
		if (
			!Array.isArray(argv) ||
			argv.length === 0 ||
			argv.some((part) => typeof part !== 'string' || part.includes('\0')) ||
			argv[0] === ''
		) {
			return Promise.reject(
				new Error('$.process.run takes an argument list: ["program", "arg", ...]'),
			)
		}
		const spec = isRecord(init) ? init : {}
		let cwd = project
		if (spec.cwd !== undefined) {
			if (typeof spec.cwd !== 'string') return Promise.reject(new Error('cwd is a path'))
			try {
				cwd = readable(spec.cwd).path
			} catch (error) {
				return Promise.reject(error)
			}
		}
		const timeoutMs = spec.timeoutMs === undefined ? DEFAULT_PROCESS_TIMEOUT_MS : spec.timeoutMs
		if (typeof timeoutMs !== 'number' || !(timeoutMs > 0)) {
			return Promise.reject(new Error('timeoutMs is a number of milliseconds'))
		}
		// Not the whole environment: a program a module starts gets the basics and the variables the
		// module reads by name, so a key kept in the environment does not travel to whatever it runs.
		const env: Record<string, string> = {}
		for (const [key, value] of Object.entries(environment)) {
			if (value === undefined) continue
			if (
				CHILD_ENVIRONMENT.includes(key) ||
				key.startsWith('LC_') ||
				options.envNames.includes(key)
			) {
				env[key] = value
			}
		}
		if (isRecord(spec.env)) {
			for (const [key, value] of Object.entries(spec.env)) {
				if (typeof value === 'string') env[key] = value
			}
		}
		if (spec.stdin !== undefined && typeof spec.stdin !== 'string') {
			return Promise.reject(new Error('stdin is text'))
		}
		const stdin = typeof spec.stdin === 'string' ? spec.stdin : undefined
		return new Promise((resolvePromise, reject) => {
			const child = spawn(argv[0] as string, (argv as string[]).slice(1), {
				cwd,
				env,
				shell: false,
				windowsHide: true,
				stdio: ['pipe', 'pipe', 'pipe'],
			})
			children.add(child)
			child.on('close', () => children.delete(child))
			child.on('error', () => children.delete(child))
			const out: Buffer[] = []
			const err: Buffer[] = []
			let outSize = 0
			let errSize = 0
			let outCut = false
			let errCut = false
			const take = (
				chunk: Buffer,
				into: Buffer[],
				size: number,
			): { size: number; cut: boolean } => {
				if (size >= MAX_CAPABILITY_BYTES) return { size, cut: true }
				const room = MAX_CAPABILITY_BYTES - size
				const piece = chunk.length > room ? chunk.subarray(0, room) : chunk
				into.push(piece)
				return { size: size + piece.length, cut: chunk.length > room }
			}
			child.stdout.on('data', (chunk: Buffer) => {
				const next = take(chunk, out, outSize)
				outSize = next.size
				outCut ||= next.cut
			})
			child.stderr.on('data', (chunk: Buffer) => {
				const next = take(chunk, err, errSize)
				errSize = next.size
				errCut ||= next.cut
			})
			const timer = setTimeout(
				() => {
					child.kill('SIGKILL')
					reject(
						new Error(
							`${String(argv[0])} did not finish within ${Math.round(Math.min(timeoutMs, MAX_PROCESS_TIMEOUT_MS) / 1000)} seconds and was ended`,
						),
					)
				},
				Math.min(timeoutMs, MAX_PROCESS_TIMEOUT_MS),
			)
			timer.unref?.()
			child.on('error', (error) => {
				clearTimeout(timer)
				reject(new Error(`${String(argv[0])}: ${error.message}`))
			})
			child.on('close', (code) => {
				clearTimeout(timer)
				resolvePromise({
					exitCode: code ?? 1,
					stdout: Buffer.concat(out).toString('utf8'),
					stderr: Buffer.concat(err).toString('utf8'),
					isStdoutTruncated: outCut,
					isStderrTruncated: errCut,
				})
			})
			child.stdin.on('error', () => undefined)
			child.stdin.end(stdin)
		})
	}

	const httpFetch = async (args: readonly unknown[]): Promise<unknown> => {
		const [url, init] = args
		if (typeof url !== 'string') throw new Error('$.http.fetch takes a URL')
		let parsed: URL
		try {
			parsed = new URL(url)
		} catch {
			throw new Error(`${url} is not a URL`)
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new Error(`${parsed.protocol} is not http or https`)
		}
		const spec = isRecord(init) ? init : {}
		const headers: Record<string, string> = {}
		if (isRecord(spec.headers)) {
			for (const [key, value] of Object.entries(spec.headers)) {
				if (typeof value === 'string') headers[key] = value
			}
		}
		if (spec.body !== undefined && typeof spec.body !== 'string') throw new Error('body is text')
		const response = await fetchImpl(parsed, {
			method: typeof spec.method === 'string' ? spec.method : 'GET',
			headers,
			...(typeof spec.body === 'string' ? { body: spec.body } : {}),
			signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
		})
		const bytes = Buffer.from(await response.arrayBuffer())
		const answered: Record<string, string> = {}
		response.headers.forEach((value, key) => {
			answered[key.toLowerCase()] = value
		})
		return {
			status: response.status,
			ok: response.ok,
			headers: answered,
			text: bytes.subarray(0, MAX_CAPABILITY_BYTES).toString('utf8'),
		}
	}

	return {
		endProcesses() {
			for (const child of children) {
				try {
					child.kill('SIGKILL')
				} catch {
					// Already gone.
				}
			}
			children.clear()
		},
		async call(noun, method, args) {
			switch (`${noun}.${method}`) {
				case 'fs.read':
					return fs.read(args)
				case 'fs.exists':
					return fs.exists(args)
				case 'fs.stat':
					return fs.stat(args)
				case 'fs.list':
					return fs.list(args)
				case 'store.get':
					return store.get(args)
				case 'store.set':
					return store.set(args)
				case 'store.delete':
					return store.delete(args)
				case 'store.keys':
					return store.keys()
				case 'process.run':
					return run(args)
				case 'http.fetch':
					return httpFetch(args)
				case 'env.get': {
					const name = args[0]
					if (typeof name !== 'string' || !options.envNames.includes(name)) {
						throw new Error(
							'$.env.get answers only a variable whose name the module writes out as a string literal',
						)
					}
					return environment[name]
				}
				case 'ui.log': {
					const text = args[0]
					options.log.info('Plugin hooks module log', {
						'namzu.plugin.name': options.pluginName,
						'namzu.hook_module.text': typeof text === 'string' ? text.slice(0, 2000) : String(text),
					})
					return undefined
				}
				default:
					throw new Error(`$.${noun}.${method} is not available in Namzu`)
			}
		},
	}
}
