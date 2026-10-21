import { type ChildProcess, fork } from 'node:child_process'
import { existsSync } from 'node:fs'
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
 * It also keeps the parent's event loop free: the multi-second parse of a large
 * bundle happens in another process, so a terminal UI keeps drawing.
 */

export type ParseOutcome =
	| { readonly kind: 'rows'; readonly parseErrors: number; readonly rows: RowsPayload }
	| { readonly kind: 'crash'; readonly detail: string }
	| { readonly kind: 'error'; readonly error: string }

/** A request this long is a hung parser, not a slow one. */
const PARSE_TIMEOUT_MS = 120_000
const BOOT_TIMEOUT_MS = 15_000

export function hostScript(): string {
	const beside = fileURLToPath(new URL('./indexer-host.js', import.meta.url))
	if (existsSync(beside)) return beside
	// Running from source (a test): the compiled child is in `dist`.
	const built = fileURLToPath(new URL('../dist/indexer-host.js', import.meta.url))
	if (existsSync(built)) return built
	throw new Error('The indexer host (dist/indexer-host.js) is not built. Run the package build.')
}

export class ParserHost {
	private child: ChildProcess | undefined
	private ready: Promise<ChildProcess> | undefined
	private queue: Promise<unknown> = Promise.resolve()

	private spawn(): Promise<ChildProcess> {
		this.ready ??= new Promise<ChildProcess>((resolve, reject) => {
			const child = fork(hostScript(), [], {
				// A heap big enough for the AST of the largest file allowed, and none
				// of the parent's debugger / loader flags.
				execArgv: ['--max-old-space-size=4096'],
				serialization: 'advanced',
				stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
			})
			const timer = setTimeout(() => {
				child.kill('SIGKILL')
				reject(new Error('The indexer host did not start.'))
			}, BOOT_TIMEOUT_MS)
			const onMessage = (m: HostReply) => {
				if (m.t !== 'ready') return
				clearTimeout(timer)
				child.off('message', onMessage)
				this.child = child
				resolve(child)
			}
			child.on('message', onMessage)
			child.once('exit', () => {
				clearTimeout(timer)
				if (this.child === child) this.child = undefined
				this.ready = undefined
				reject(new Error('The indexer host exited before it was ready.'))
			})
			child.once('error', (err) => {
				clearTimeout(timer)
				reject(err)
			})
		})
		return this.ready
	}

	/** Parse one file's text in the child. Never throws for a crash. */
	parse(
		job: { rel: string; abs: string; text: string },
		signal?: AbortSignal,
	): Promise<ParseOutcome> {
		const run = async (): Promise<ParseOutcome> => {
			if (signal?.aborted) throw abortError()
			const child = await this.spawn()
			return await new Promise<ParseOutcome>((resolve, reject) => {
				let started = false
				const cleanup = () => {
					clearTimeout(timer)
					child.off('message', onMessage)
					child.off('exit', onExit)
					signal?.removeEventListener('abort', onAbort)
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
					if (this.child === child) this.child = undefined
					this.ready = undefined
					resolve({
						kind: 'crash',
						detail: `the parser process ended ${sig ? `with ${sig}` : `with exit code ${code}`}${started ? '' : ' before it began'}`,
					})
				}
				const onAbort = () => {
					cleanup()
					this.kill()
					reject(abortError())
				}
				const timer = setTimeout(() => {
					cleanup()
					this.kill()
					resolve({
						kind: 'crash',
						detail: `the parser ran past ${PARSE_TIMEOUT_MS / 1000} seconds and was stopped`,
					})
				}, PARSE_TIMEOUT_MS)
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

	kill(): void {
		const child = this.child
		this.child = undefined
		this.ready = undefined
		child?.kill('SIGKILL')
	}
}

export function abortError(): Error {
	const err = new Error('The operation was cancelled.')
	err.name = 'AbortError'
	return err
}
