import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'

import { encodeCodeValue } from './json-value.js'
import {
	type CodeRunResult,
	type CodeRuntime,
	HostCallDeniedError,
	type RunCodeOptions,
} from './types.js'
import { QUICKJS_WORKER_SOURCE } from './worker-program.js'

const requireFromSdk = createRequire(import.meta.url)

/** Resource policy for one fresh QuickJS worker execution. */
export interface WorkerCodeRuntimeOptions {
	/** QuickJS allocator limit, also the WASM linear-memory ceiling. Does not bound total Node/process memory. Default: 64 MiB. */
	readonly memoryLimitBytes?: number
	/** Maximum UTF-8 program source size. Default: 256 KiB. */
	readonly maxSourceBytes?: number
	/** Maximum UTF-8 JSON size of each input, host result, and program return. Default: 1 MiB. */
	readonly maxValueBytes?: number
	/** Maximum host calls admitted by one program, including refusals. Default: 100. */
	readonly maxHostCalls?: number
	/** Maximum host calls awaiting replies simultaneously. Default: 100. */
	readonly maxPendingHostCalls?: number
}

function validateInteger(name: string, value: number, minimum: number, maximum: number): void {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`)
	}
}

function resolveLimits(options: WorkerCodeRuntimeOptions): Required<WorkerCodeRuntimeOptions> {
	const limits = {
		memoryLimitBytes: options.memoryLimitBytes ?? 64 * 1024 * 1024,
		maxSourceBytes: options.maxSourceBytes ?? 256 * 1024,
		maxValueBytes: options.maxValueBytes ?? 1024 * 1024,
		maxHostCalls: options.maxHostCalls ?? 100,
		maxPendingHostCalls: options.maxPendingHostCalls ?? options.maxHostCalls ?? 100,
	}
	validateInteger('memoryLimitBytes', limits.memoryLimitBytes, 16 * 1024 * 1024, 256 * 1024 * 1024)
	validateInteger('maxSourceBytes', limits.maxSourceBytes, 1, 4 * 1024 * 1024)
	validateInteger('maxValueBytes', limits.maxValueBytes, 1, 16 * 1024 * 1024)
	validateInteger('maxHostCalls', limits.maxHostCalls, 1, 10_000)
	validateInteger('maxPendingHostCalls', limits.maxPendingHostCalls, 1, limits.maxHostCalls)
	return limits
}

function decodeValue(json: unknown, maxBytes: number): unknown {
	if (json === undefined) return undefined
	if (typeof json !== 'string' || Buffer.byteLength(json) > maxBytes) {
		throw new Error('Code runtime value exceeds the serialized value limit.')
	}
	return JSON.parse(json)
}

/**
 * Runs untrusted JavaScript in a QuickJS interpreter inside a worker thread.
 * QuickJS owns the guest globals, functions, and promises. Node capabilities
 * never enter that realm; constructors and dynamic imports cannot recover them.
 * A fresh interpreter and bounded imported WASM memory are created per run.
 * The worker makes wall-clock cancellation independent of interpreter progress.
 */
export class WorkerCodeRuntime implements CodeRuntime {
	readonly id = 'worker_threads'
	private readonly limits: Required<WorkerCodeRuntimeOptions>

	constructor(options: WorkerCodeRuntimeOptions = {}) {
		this.limits = resolveLimits(options)
	}

	async run(options: RunCodeOptions): Promise<CodeRunResult> {
		validateInteger('timeoutMs', options.timeoutMs, 1, 2_147_483_647)
		validateInteger('maxOutputBytes', options.maxOutputBytes, 0, 16 * 1024 * 1024)
		const allowed = new Set(options.allowedCalls)
		const calls: { name: string; ok: boolean }[] = []
		let output = ''
		let truncated = false
		let printCount = 0
		const seenCalls = new Set<number>()

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

		if (
			options.source.length > this.limits.maxSourceBytes ||
			Buffer.byteLength(options.source) > this.limits.maxSourceBytes
		) {
			return {
				outcome: {
					status: 'failed',
					error: `Program source exceeds ${this.limits.maxSourceBytes} bytes.`,
				},
				output,
				outputTruncated: truncated,
				calls,
			}
		}

		const appendOutput = (lines: readonly string[]): void => {
			for (const line of lines) {
				if (truncated) return
				const next = printCount === 0 ? line : `${output}\n${line}`
				if (Buffer.byteLength(next) > options.maxOutputBytes) {
					// Cut at the LINE that would exceed, and say so. A cut
					// mid-JSON produces output a reader cannot parse and cannot
					// tell was cut.
					truncated = true
					return
				}
				output = next
				printCount++
			}
		}

		const worker = new Worker(QUICKJS_WORKER_SOURCE, {
			eval: true,
			workerData: {
				source: options.source,
				corePath: requireFromSdk.resolve('quickjs-emscripten-core'),
				variantPath: requireFromSdk.resolve('@jitl/quickjs-wasmfile-release-sync'),
				limits: this.limits,
				maxOutputBytes: options.maxOutputBytes,
				deadline: Date.now() + options.timeoutMs,
			},
			// Trusted bootstrap requires Node; guest code runs only inside QuickJS.
			// Avoid inheriting --input-type or test loaders into the CJS bootstrap.
			execArgv: [],
			env: {},
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
				if (settled) return
				if (message.kind === 'truncated') {
					truncated = true
					return
				}
				if (message.kind === 'timed-out') {
					operation.abort(new Error(`Code runtime exceeded ${options.timeoutMs}ms`))
					finish({
						outcome: { status: 'timed-out' },
						output,
						outputTruncated: truncated,
						calls,
					})
					return
				}
				if (message.kind === 'call') {
					const name = String(message.name)
					const id = message.id
					if (
						typeof id !== 'number' ||
						!Number.isSafeInteger(id) ||
						id < 1 ||
						seenCalls.has(id) ||
						seenCalls.size >= this.limits.maxHostCalls ||
						inFlight.size >= this.limits.maxPendingHostCalls
					) {
						finish({
							outcome: {
								status: 'failed',
								error: 'Invalid or over-budget host call.',
							},
							output,
							outputTruncated: truncated,
							calls,
						})
						return
					}
					seenCalls.add(id)
					let input: unknown
					try {
						input = decodeValue(message.json, this.limits.maxValueBytes)
					} catch (error) {
						finish({
							outcome: { status: 'failed', error: String(error) },
							output,
							outputTruncated: truncated,
							calls,
						})
						return
					}
					if (!allowed.has(name)) {
						// Authorization remains host-owned even though the interpreter
						// also bounds its own bridge. A worker never expands the grant.
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
							options.onHostCall({ name, input }, { runtimeToolCallId, signal: operation.signal }),
						)
						.then((result) => {
							if (settled) return
							let json: string | undefined
							try {
								json = result.ok
									? encodeCodeValue(result.value, this.limits.maxValueBytes)
									: undefined
							} catch (error) {
								throw new Error(
									`Host call "${name}" completed, but its result could not be delivered: ${error instanceof Error ? error.message : String(error)} Do not repeat a state-changing call solely to recover its output.`,
								)
							}
							calls.push({ name, ok: result.ok })
							worker.postMessage({
								kind: 'call-result',
								id,
								ok: result.ok,
								json,
								error: result.error?.slice(0, 4096),
							})
						})
						.catch((err: unknown) => {
							if (settled) return
							calls.push({ name, ok: false })
							worker.postMessage({
								kind: 'call-result',
								id,
								ok: false,
								error: (err instanceof Error ? err.message : String(err)).slice(0, 4096),
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
					let value: unknown
					try {
						value = decodeValue(message.json, this.limits.maxValueBytes)
					} catch (error) {
						finish({
							outcome: { status: 'failed', error: String(error) },
							output,
							outputTruncated: truncated,
							calls,
						})
						return
					}
					terminal = {
						outcome: { status: 'completed', result: value },
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
				// A bootstrap or interpreter failure may exit before a terminal
				// message. Guest code has no access to Node's process object.
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
