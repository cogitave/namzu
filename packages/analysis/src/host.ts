import { type ChildProcess, fork } from 'node:child_process'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { HostReply, HostRequest } from './indexer-host.js'
import { ParserUnavailableError } from './parse.js'
import type { RowsPayload } from './walk.js'

/**
 * The parent's handle on the parsing child.
 *
 * Why a process: see `indexer-host.ts`. What this adds is the other half of
 * the bargain — a dead child is an answer, not a failure. `parse` resolves
 * `{ kind: 'crash' }` naming the file, the next call starts a fresh child, and
 * the caller moves on to the next file. Requests are queued one at a time, so
 * "the file in flight" is never ambiguous.
 *
 * A child WE kill is a different thing from one that died: cancelling a parse
 * (or disposing the host) rejects with an abort error and records nothing
 * against the file, which was healthy.
 *
 * It also keeps the parent's event loop free: the multi-second parse of a large
 * bundle happens in another process, so a terminal UI keeps drawing. And an
 * idle child never holds the parent open: its handle and IPC channel are
 * unref'd between requests.
 */

export type ParseOutcome =
	| { readonly kind: 'rows'; readonly parseErrors: number; readonly rows: RowsPayload }
	| { readonly kind: 'crash'; readonly detail: string }
	| { readonly kind: 'error'; readonly error: string }

/** A request this long is a hung parser, not a slow one. */
const PARSE_TIMEOUT_MS = 120_000
/** A parse is always given at least this long, whatever is left of a call's budget. */
export const MIN_PARSE_MS = 10_000
const BOOT_TIMEOUT_MS = 15_000

export function hostScript(override?: string): string {
	if (override !== undefined) {
		// Absolute: the child runs in the temp directory, not this process's
		// working directory, so a relative path would name a different file there.
		if (existsSync(override)) return resolve(override)
		// A path the host named that does not exist is a packaging mistake worth
		// naming, not something to paper over with a guess.
		throw new Error(`The indexer host script ${override} does not exist.`)
	}
	const beside = fileURLToPath(new URL('./indexer-host.js', import.meta.url))
	if (existsSync(beside)) return beside
	// Running from source (a test): the compiled child is in `dist`.
	const built = fileURLToPath(new URL('../dist/indexer-host.js', import.meta.url))
	if (existsSync(built)) return built
	throw new Error('The indexer host (dist/indexer-host.js) is not built. Run the package build.')
}

/**
 * What the child is given of this process's environment: enough to run Node,
 * and none of the rest. The parent's environment is a CLI's, which holds API
 * keys; a parser has no use for them and a native crash dump or a hostile
 * input should not be able to find them.
 */
export function childEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const keep = ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'SystemRoot', 'LANG', 'LC_ALL']
	const out: NodeJS.ProcessEnv = {}
	for (const key of keep) if (env[key] !== undefined) out[key] = env[key]
	return out
}

/**
 * Keep a crashed child's core dump to its headers. The parser's raw transfer
 * maps a 6 GiB anonymous buffer (measured: 6.00 GiB `rw-p` in a child that
 * has parsed one small file, 57 MB resident), and a dump includes every
 * anonymous mapping that has been written to, untouched pages and all. Into a
 * file those pages are holes; into a pipe they are zeros, and a pipe is what
 * `core_pattern` names on Ubuntu (apport) and systemd systems
 * (systemd-coredump). The kernel does not apply `ulimit -c` to a pipe, so the
 * handler is sent the whole mapping whatever it then keeps, and the child does
 * not finish dying until the handler has read it.
 * The dump would also hold the source being parsed. `coredump_filter` 0 drops
 * every anonymous and file mapping from the dump, leaving the registers and
 * the mapping list. Linux only, and best effort: a /proc that refuses the
 * write leaves the dump as the system configured it.
 */
function withoutCoreDump(pid: number | undefined): void {
	if (process.platform !== 'linux' || pid === undefined) return
	try {
		writeFileSync(`/proc/${pid}/coredump_filter`, '0')
	} catch {
		// Nothing to do: the filter is an economy, not a guarantee.
	}
}

/**
 * Node's permission model for the child: it may read the files it loads (its
 * own script and the directories above and beside it, and `node_modules`, where
 * the parser and its native binding live), and nothing else. It may not write,
 * spawn processes or start workers. The source text it parses arrives over IPC,
 * so it needs no access to the project.
 *
 * Two things the model does not do, stated so nobody assumes it does: it does
 * not restrict the network, and `--allow-addons` is required to load the
 * parser's native binding, which means native code in the child is not itself
 * confined. The empty environment above is what limits what that code can find.
 *
 * Verified with `oxc-parser` 0.155.0 on Node 22.13.0 and 24.19.0. When the
 * parser's location cannot be worked out, or the host runs a parser the caller
 * named, the child runs without it rather than failing to start.
 */
export function permissionArguments(script: string, parserModule: string | undefined): string[] {
	if (parserModule !== undefined) return []
	try {
		const real = realpathSync(createRequire(script).resolve('oxc-parser'))
		const marker = `${sep}node_modules${sep}`
		const at = real.indexOf(marker)
		if (at < 0) return []
		const modules = real.slice(0, at + marker.length - 1)
		const scriptDir = dirname(realpathSync(script))
		return [
			'--permission',
			'--allow-addons',
			`--allow-fs-read=${scriptDir}`,
			`--allow-fs-read=${dirname(scriptDir)}`,
			`--allow-fs-read=${modules}`,
		]
	} catch {
		return []
	}
}

export class ParserHost {
	/** The child being started or running; only events from THIS one may reset state. */
	private current: ChildProcess | undefined
	private ready: Promise<ChildProcess> | undefined
	private queue: Promise<unknown> = Promise.resolve()
	private disposed = false
	/** Children this host killed on purpose, so their exit is not read as a crash. */
	private readonly killed = new WeakSet<ChildProcess>()

	constructor(
		private readonly script?: string,
		private readonly parserModule?: string,
	) {}

	private spawn(): Promise<ChildProcess> {
		if (this.disposed) return Promise.reject(abortError())
		this.ready ??= new Promise<ChildProcess>((resolve, reject) => {
			const script = hostScript(this.script)
			const child = fork(script, this.parserModule !== undefined ? [this.parserModule] : [], {
				// Not the project: a crash handler that writes `core` into the
				// crashed process's working directory must not write it there.
				cwd: tmpdir(),
				// A heap big enough for the AST of the largest file allowed, none of
				// the parent's debugger / loader flags, and the permission model.
				execArgv: ['--max-old-space-size=4096', ...permissionArguments(script, this.parserModule)],
				env: childEnvironment(),
				serialization: 'advanced',
				stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
			})
			// Before the first parse request, so before anything it could crash on.
			withoutCoreDump(child.pid)
			this.current = child
			const timer = setTimeout(() => {
				this.kill(child)
				reject(new Error('The indexer host did not start.'))
			}, BOOT_TIMEOUT_MS)
			const onMessage = (m: HostReply) => {
				if (m.t !== 'ready') return
				clearTimeout(timer)
				child.off('message', onMessage)
				this.idle(child)
				resolve(child)
			}
			const forget = () => {
				// Only the child that is still current may clear the slot: a late
				// event from one killed earlier must not reset its successor's.
				if (this.current === child) {
					this.current = undefined
					this.ready = undefined
				}
			}
			child.on('message', onMessage)
			child.once('exit', () => {
				clearTimeout(timer)
				forget()
				reject(new Error('The indexer host exited before it was ready.'))
			})
			child.once('error', (err) => {
				clearTimeout(timer)
				forget()
				reject(err)
			})
		})
		return this.ready
	}

	/** Between requests the child must not keep the parent's event loop alive. */
	private idle(child: ChildProcess): void {
		child.unref()
		child.channel?.unref()
	}

	private busy(child: ChildProcess): void {
		child.ref()
		child.channel?.ref()
	}

	/**
	 * Parse one file's text in the child. Never throws for a crash; throws an
	 * abort error when cancelled or disposed. `timeoutMs` bounds this parse.
	 */
	parse(
		job: { rel: string; abs: string; text: string },
		signal?: AbortSignal,
		timeoutMs = PARSE_TIMEOUT_MS,
	): Promise<ParseOutcome> {
		const run = async (): Promise<ParseOutcome> => {
			if (signal?.aborted || this.disposed) throw abortError()
			const child = await this.spawn()
			if (signal?.aborted || this.disposed) throw abortError()
			return await new Promise<ParseOutcome>((resolve, reject) => {
				let started = false
				this.busy(child)
				const cleanup = () => {
					clearTimeout(timer)
					child.off('message', onMessage)
					child.off('exit', onExit)
					signal?.removeEventListener('abort', onAbort)
					if (!child.killed) this.idle(child)
				}
				const onMessage = (m: HostReply) => {
					if (m.t === 'start') {
						started = true
						return
					}
					if (m.t === 'done' && m.rel === job.rel) {
						cleanup()
						resolve({ kind: 'rows', parseErrors: m.parseErrors, rows: m.rows })
					} else if (m.t === 'fail' && m.rel === job.rel) {
						cleanup()
						if (m.unavailable) reject(new ParserUnavailableError(m.error))
						else resolve({ kind: 'error', error: m.error })
					}
				}
				const onExit = (code: number | null, sig: NodeJS.Signals | null) => {
					cleanup()
					if (this.current === child) {
						this.current = undefined
						this.ready = undefined
					}
					// We killed it (cancel, dispose): the file did nothing wrong.
					if (this.killed.has(child)) {
						reject(abortError())
						return
					}
					resolve({
						kind: 'crash',
						detail: `the parser process ended ${sig ? `with ${sig}` : `with exit code ${code}`}${started ? '' : ' before it began'}`,
					})
				}
				const onAbort = () => {
					cleanup()
					this.kill(child)
					reject(abortError())
				}
				const limit = Math.min(timeoutMs, PARSE_TIMEOUT_MS)
				const timer = setTimeout(() => {
					cleanup()
					this.kill(child)
					resolve({
						kind: 'crash',
						detail: `the parser ran past ${Math.round(limit / 1000)} seconds and was stopped`,
					})
				}, limit)
				child.on('message', onMessage)
				child.once('exit', onExit)
				signal?.addEventListener('abort', onAbort, { once: true })
				child.send({ t: 'parse', ...job } satisfies HostRequest)
			})
		}
		const next = this.queue.then(run, run)
		this.queue = next.catch(() => undefined)
		return next
	}

	private kill(child: ChildProcess | undefined): void {
		if (!child) return
		this.killed.add(child)
		if (this.current === child) {
			this.current = undefined
			this.ready = undefined
		}
		child.kill('SIGKILL')
	}

	/** Stop the child now, without closing the host: the next parse starts a new one. */
	killChild(): void {
		this.kill(this.current)
	}

	/** Close the host: nothing parses after this, and a parse in flight is cancelled. */
	dispose(): void {
		this.disposed = true
		this.kill(this.current)
	}
}

export function abortError(): Error {
	const err = new Error('The operation was cancelled.')
	err.name = 'AbortError'
	return err
}
