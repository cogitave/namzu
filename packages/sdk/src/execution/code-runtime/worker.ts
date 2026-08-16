import { Worker } from 'node:worker_threads'

import {
	type CodeRunResult,
	type CodeRuntime,
	HostCallDeniedError,
	type RunCodeOptions,
} from './types.js'

/**
 * A `worker_threads` backend.
 *
 * Chosen over `vm` because `vm` is not a sandbox and its own documentation
 * says so: a context shares the process, so a program that reaches a
 * constructor from the host realm is out — `this.constructor.constructor`
 * on any leaked object is the whole escape, and it fits in a tweet. A
 * worker is a separate V8 isolate with its own heap; escaping it means
 * escaping V8.
 *
 * Chosen over a subprocess because a subprocess is a process: it inherits
 * an environment, it can be a fork bomb, and killing it is the process-tree
 * problem `process/kill-tree.ts` exists for. A worker is cheaper to start,
 * cheaper to kill, and cannot outlive the process that made it.
 *
 * What a worker does NOT give, stated because it is the reason this is not
 * the whole answer: a worker shares the process's filesystem and network
 * access. It is not confined by anything the OS enforces. What confines the
 * program here is that it is handed a scope with nothing in it — no
 * `require`, no `process`, no `fetch` — and a single channel back to the
 * host. That is a language-level boundary, and a language-level boundary is
 * exactly as strong as the enumeration of what was withheld. So a host that
 * needs an OS boundary runs this inside a sandbox that has one, and this
 * comment is here so nobody concludes the worker was the boundary.
 */

/**
 * The worker's own body, as source.
 *
 * Inlined rather than a separate file because a separate file has to be
 * findable at runtime, and this package is consumed as `dist/` by hosts
 * whose bundlers rewrite paths. A string has no path.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')

// Every host call is a request/response over the port, keyed by an id so
// several can be in flight — a program that awaits two calls at once is
// ordinary, and a channel that could only carry one would silently
// serialise them.
const pending = new Map()
let nextId = 0

function hostCall(name, input) {
	const id = ++nextId
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject })
		parentPort.postMessage({ kind: 'call', id, name, input })
	})
}

const output = []
function print(...parts) {
	output.push(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '))
}

parentPort.on('message', (message) => {
	if (message.kind !== 'call-result') return
	const entry = pending.get(message.id)
	if (!entry) return
	pending.delete(message.id)
	if (message.ok) entry.resolve(message.value)
	else entry.reject(new Error(message.error))
})

async function main() {
	// The scope the program runs in, and everything it has. Built with
	// \`new Function\` over an explicit parameter list rather than with
	// \`with\` or a Proxy: the parameters SHADOW the outer names, so a
	// program writing \`require\` gets the parameter, and the parameter is
	// undefined.
	const names = ['call', 'print', 'require', 'process', 'module', 'exports', 'globalThis', 'fetch']
	const values = [hostCall, print, undefined, undefined, undefined, undefined, undefined, undefined]
	const body = new Function(...names, '"use strict";return (async () => {' + workerData.source + '\\n})()')
	return await body(...values)
}

main().then(
	(result) => parentPort.postMessage({ kind: 'done', result, output }),
	(error) => parentPort.postMessage({ kind: 'error', error: String(error && error.message || error), output }),
)
`

export class WorkerCodeRuntime implements CodeRuntime {
	readonly id = 'worker_threads'

	async run(options: RunCodeOptions): Promise<CodeRunResult> {
		const allowed = new Set(options.allowedCalls)
		const calls: { name: string; ok: boolean }[] = []
		let output = ''
		let truncated = false

		const appendOutput = (lines: readonly string[]): void => {
			for (const line of lines) {
				if (truncated) return
				const next = output.length === 0 ? line : `${output}\n${line}`
				if (Buffer.byteLength(next) > options.maxOutputBytes) {
					// Cut at the LINE that would exceed, and say so. A cut
					// mid-JSON produces output a reader cannot parse and cannot
					// tell was cut.
					truncated = true
					return
				}
				output = next
			}
		}

		const worker = new Worker(WORKER_SOURCE, {
			eval: true,
			workerData: { source: options.source },
			// Nothing from the host's environment.
			//
			// **Unobservable today, and kept deliberately.** `process` is
			// shadowed in the program's scope, so nothing the program can
			// write reaches `process.env` either way — a mutation removing
			// this line passes every test, correctly. It is defence behind the
			// shadowing rather than beside it: the shadowing is a
			// language-level boundary, exactly as strong as the enumeration of
			// what was withheld, and the day that enumeration misses something
			// this is what the leak finds. The cost is one empty object.
			env: {},
			// No stdio inheritance: the program prints through `print`, which
			// is bounded. A worker writing to the host's stdout would bypass
			// the cap and interleave with the operator's own output.
			stdout: true,
			stderr: true,
		})

		return await new Promise<CodeRunResult>((resolve) => {
			let settled = false
			const finish = (result: CodeRunResult): void => {
				// The Promise already ignores a second `resolve`, so removing
				// this guard changes no result — a mutation removing it
				// survives, correctly. It is kept because it also stops a
				// second `terminate()` and a second `clearTimeout` on a worker
				// that has already gone, and because `finish` is called from
				// four places whose ordering is decided by the worker: `done`
				// then `exit` is the ordinary sequence, not an edge case.
				if (settled) return
				settled = true
				clearTimeout(deadline)
				options.signal?.removeEventListener('abort', onAbort)
				void worker.terminate()
				resolve(result)
			}

			const deadline = setTimeout(() => {
				finish({ outcome: { status: 'timed-out' }, output, outputTruncated: truncated, calls })
			}, options.timeoutMs)

			const onAbort = (): void => {
				finish({ outcome: { status: 'cancelled' }, output, outputTruncated: truncated, calls })
			}
			options.signal?.addEventListener('abort', onAbort, { once: true })
			if (options.signal?.aborted) {
				onAbort()
				return
			}

			worker.on('message', (message: Record<string, unknown>) => {
				if (message.kind === 'call') {
					const name = String(message.name)
					const id = message.id
					if (!allowed.has(name)) {
						// Refused HERE, not in the worker. The allow-list lives on
						// the host side because a check inside the worker is a
						// check the program shares a heap with.
						calls.push({ name, ok: false })
						worker.postMessage({
							kind: 'call-result',
							id,
							ok: false,
							error: new HostCallDeniedError({ name, allowed: options.allowedCalls }).message,
						})
						return
					}
					void options
						.onHostCall({ name, input: message.input })
						.then((result) => {
							calls.push({ name, ok: result.ok })
							worker.postMessage({
								kind: 'call-result',
								id,
								ok: result.ok,
								value: result.value,
								error: result.error,
							})
						})
						.catch((err: unknown) => {
							calls.push({ name, ok: false })
							worker.postMessage({
								kind: 'call-result',
								id,
								ok: false,
								error: err instanceof Error ? err.message : String(err),
							})
						})
					return
				}

				if (message.kind === 'done') {
					appendOutput((message.output as string[]) ?? [])
					finish({
						outcome: { status: 'completed', result: message.result },
						output,
						outputTruncated: truncated,
						calls,
					})
					return
				}

				if (message.kind === 'error') {
					appendOutput((message.output as string[]) ?? [])
					finish({
						outcome: { status: 'failed', error: String(message.error) },
						output,
						outputTruncated: truncated,
						calls,
					})
				}
			})

			worker.on('error', (err) => {
				// A worker that died before reporting anything. Its output is
				// whatever it had already sent, which is nothing — reporting an
				// empty string here is honest rather than a loss.
				finish({
					outcome: { status: 'failed', error: err.message },
					output,
					outputTruncated: truncated,
					calls,
				})
			})

			worker.on('exit', (code) => {
				// Only reached when the worker exited without a `done` or
				// `error` message — a hard crash, or a program that called
				// `process.exit` through something we failed to withhold.
				finish({
					outcome: { status: 'failed', error: `The program exited with code ${code}.` },
					output,
					outputTruncated: truncated,
					calls,
				})
			})
		})
	}
}
