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

// Posted as it happens, NOT batched until the end. A program that printed
// its progress and then hung has told the host where it got to, and a
// buffer that only ships on completion loses exactly the output a timeout
// most needs to explain itself.
function print(...parts) {
	parentPort.postMessage({
		kind: 'print',
		line: parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '),
	})
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
	(result) => parentPort.postMessage({ kind: 'done', result }),
	(error) => parentPort.postMessage({ kind: 'error', error: String(error && error.message || error) }),
)
`

export class WorkerCodeRuntime implements CodeRuntime {
	readonly id = 'worker_threads'

	async run(options: RunCodeOptions): Promise<CodeRunResult> {
		const allowed = new Set(options.allowedCalls)
		const calls: { name: string; ok: boolean }[] = []
		let output = ''
		let truncated = false

		// A withdrawn caller owns admission. Do not start an isolate merely to
		// discover the signal was already aborted after construction.
		if (options.signal?.aborted) {
			return {
				outcome: { status: 'cancelled' },
				output,
				outputTruncated: truncated,
				calls,
			}
		}

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
			let terminal: CodeRunResult | undefined
			const inFlight = new Set<Promise<void>>()
			const operation = new AbortController()

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
				// Terminating the worker only stops the program. Host work already
				// admitted through onHostCall lives outside it, so revoke the signal
				// that was handed to every such call before reporting settlement.
				if (!operation.signal.aborted) {
					operation.abort(new Error(`Code runtime settled with status ${result.outcome.status}`))
				}
				clearTimeout(deadline)
				options.signal?.removeEventListener('abort', onAbort)
				void worker.terminate()
				// A late, non-cooperative host call must not mutate a result the
				// caller already received.
				resolve({ ...result, calls: [...calls] })
			}

			const finishTerminalWhenHostCallsSettle = (): void => {
				if (terminal && inFlight.size === 0) finish(terminal)
			}

			const deadline = setTimeout(() => {
				operation.abort(new Error(`Code runtime exceeded ${options.timeoutMs}ms`))
				finish({
					outcome: { status: 'timed-out' },
					output,
					outputTruncated: truncated,
					calls,
				})
			}, options.timeoutMs)

			const onAbort = (): void => {
				operation.abort(options.signal?.reason)
				finish({
					outcome: { status: 'cancelled' },
					output,
					outputTruncated: truncated,
					calls,
				})
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
							error: new HostCallDeniedError({
								name,
								allowed: options.allowedCalls,
							}).message,
						})
						return
					}
					const runtimeToolCallId = String(id)
					const hostCall = Promise.resolve()
						.then(() =>
							options.onHostCall(
								{ name, input: message.input },
								{ runtimeToolCallId, signal: operation.signal },
							),
						)
						.then((result) => {
							if (settled) return
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
							if (settled) return
							calls.push({ name, ok: false })
							worker.postMessage({
								kind: 'call-result',
								id,
								ok: false,
								error: err instanceof Error ? err.message : String(err),
							})
						})
						.finally(() => {
							inFlight.delete(hostCall)
							finishTerminalWhenHostCallsSettle()
						})
					inFlight.add(hostCall)
					return
				}

				if (message.kind === 'print') {
					appendOutput([String(message.line)])
					return
				}

				if (message.kind === 'done') {
					// A program may start a host call without awaiting it. The worker
					// declaring its JavaScript body complete is not evidence that the
					// effect it started is complete, so keep the runtime open until the
					// already-admitted host calls settle (or the deadline revokes them).
					terminal = {
						outcome: { status: 'completed', result: message.result },
						output,
						outputTruncated: truncated,
						calls,
					}
					finishTerminalWhenHostCallsSettle()
					return
				}

				if (message.kind === 'error') {
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
					outcome: {
						status: 'failed',
						error: `The program exited with code ${code}.`,
					},
					output,
					outputTruncated: truncated,
					calls,
				})
			})
		})
	}
}
