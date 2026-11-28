/**
 * The helper as a process: start it, greet it, send it requests as lines and
 * match the replies to them by id.
 *
 * The helper is the compiled `namzu-native` executable. It is started directly,
 * with no shell and no script engine, and answers JSON lines on its standard
 * output. Everything the TypeScript side asks of it goes through
 * {@link NativeWinProcess.request}, which gives a reply body or throws an
 * {@link A11yError} carrying the helper's own error code.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { A11yError } from '../a11y/interface.js'
import {
	LEGACY_NATIVE_PROTOCOL,
	NATIVE_PROTOCOL,
	type NativeHello,
	type NativeOp,
	NativeProtocolError,
	type NativeReplyBodies,
	type NativeRequest,
	decodeReply,
	encodeRequest,
} from './protocol.js'

/** The ends of a started helper; the real one is a child process. */
export interface NativeChannel {
	write(line: string): void
	onLine(handler: (line: string) => void): void
	onExit(handler: () => void): void
	kill(): void
}

export interface NativeWinProcessOptions {
	/** The path of `namzu-native.exe`. */
	readonly executable: string
	/** Sent in `hello`, so the helper's log can say who asked. */
	readonly cliVersion?: string
	readonly env?: NodeJS.ProcessEnv
	/** For tests. */
	readonly spawnHelper?: () => NativeChannel
	/** Waiting for the greeting, ms. Default 10 000. */
	readonly startTimeoutMs?: number
	/** How many times a helper that ended mid-session is started again. Default 3. */
	readonly maxRestarts?: number
	/** A helper that ran this long before ending was healthy: the restart count starts again. Default 60 000. */
	readonly stableAfterMs?: number
}

/** The client gives up on a reply this long after the helper should have sent it, ms. */
const BACKSTOP_MS = 1_500

function spawnHelperProcess(options: NativeWinProcessOptions): NativeChannel {
	// The executable alone: no shell, no arguments, no window.
	const child = spawn(options.executable, [], {
		env: options.env,
		stdio: ['pipe', 'pipe', 'ignore'],
		windowsHide: true,
		shell: false,
	})
	child.stdin.on('error', () => undefined)
	child.on('error', () => undefined)
	return {
		write: (line) => {
			child.stdin.write(`${line}\n`)
		},
		onLine: (handler) => createInterface({ input: child.stdout }).on('line', handler),
		onExit: (handler) => {
			child.once('exit', handler)
			child.once('error', handler)
		},
		kill: () => {
			try {
				// Closing the input ends the helper by itself.
				child.stdin.end()
			} catch {
				// Already closed.
			}
			setTimeout(() => child.kill(), 2_000).unref()
		},
	}
}

interface Pending {
	readonly op: NativeOp
	readonly resolve: (body: unknown) => void
	readonly reject: (error: A11yError) => void
	readonly timer: NodeJS.Timeout
	readonly cleanup: () => void
}

export class NativeWinProcess {
	private channel: NativeChannel | undefined
	private starting: Promise<boolean> | undefined
	private up = false
	private dead = false
	private closed = false
	private restarts = 0
	private runs = 0
	private nextId = 1
	private greeting: NativeHello | undefined
	private readonly pending = new Map<number, Pending>()

	constructor(private readonly options: NativeWinProcessOptions) {}

	/** True once the helper greeted and has not ended since. */
	get isUp(): boolean {
		return this.up && !this.dead && !this.closed
	}

	/** Counts the helper's starts: a marker taken before a restart is stale. */
	get epoch(): number {
		return this.runs
	}

	/** What the helper said in `hello`, once it has. */
	get hello(): NativeHello | undefined {
		return this.greeting
	}

	warm(): void {
		if (!this.dead && !this.closed) void this.start()
	}

	/** Ends the helper while nobody uses it; the next question starts it again. */
	release(): void {
		const channel = this.channel
		if (!channel) return
		// Replaced, not ended: its exit is not a crash (see the exit handler).
		this.channel = undefined
		this.starting = undefined
		this.up = false
		this.failAll(new A11yError('helper_exited', 'the native helper was released'))
		this.sendQuit(channel)
	}

	ready(): Promise<boolean> {
		if (this.dead || this.closed) return Promise.resolve(false)
		return this.start()
	}

	async close(): Promise<void> {
		this.closed = true
		const channel = this.channel
		this.channel = undefined
		this.up = false
		this.failAll(new A11yError('closed', 'the native helper was closed'))
		if (channel) this.sendQuit(channel)
	}

	/**
	 * One request, one reply. `limitMs` is how long the helper has to answer
	 * (it is also what the request's own timeout says); a little more is
	 * allowed before the client gives up on a helper that says nothing.
	 */
	async request<K extends NativeOp>(
		request: NativeRequest & { readonly op: K },
		limitMs: number,
		signal?: AbortSignal,
	): Promise<NativeReplyBodies[K]> {
		if (signal?.aborted) throw new A11yError('aborted', 'cancelled')
		if (!(await this.ready())) throw new A11yError('unavailable', 'the native helper is off')
		const channel = this.channel
		if (!channel || !this.up) throw new A11yError('helper_exited', 'the native helper ended')
		const id = this.nextId++
		return new Promise<NativeReplyBodies[K]>((resolve, reject) => {
			const settle = (): void => {
				signal?.removeEventListener('abort', onAbort)
			}
			const onAbort = (): void => {
				if (!this.pending.delete(id)) return
				clearTimeout(timer)
				this.cancelAtHelper(id)
				reject(new A11yError('aborted', 'cancelled'))
			}
			const timer = setTimeout(() => {
				if (!this.pending.delete(id)) return
				settle()
				this.cancelAtHelper(id)
				reject(new A11yError('timeout', `the native helper did not answer ${request.op}`))
			}, limitMs + BACKSTOP_MS)
			timer.unref?.()
			signal?.addEventListener('abort', onAbort, { once: true })
			this.pending.set(id, {
				op: request.op,
				resolve: resolve as (body: unknown) => void,
				reject,
				timer,
				cleanup: settle,
			})
			try {
				channel.write(encodeRequest(id, request))
			} catch {
				this.pending.delete(id)
				clearTimeout(timer)
				settle()
				reject(new A11yError('helper_exited', 'the native helper ended'))
			}
		})
	}

	private sendQuit(channel: NativeChannel): void {
		try {
			channel.write(encodeRequest(this.nextId++, { op: 'quit' }))
		} catch {
			// Already gone.
		}
		channel.kill()
	}

	/** Tells the helper to stop work nobody waits for any more. Never throws. */
	private cancelAtHelper(target: number): void {
		try {
			this.channel?.write(encodeRequest(this.nextId++, { op: 'cancel', target }))
		} catch {
			// The helper is gone; there is nothing to cancel.
		}
	}

	private failAll(error: A11yError): void {
		for (const [id, entry] of [...this.pending]) {
			this.pending.delete(id)
			clearTimeout(entry.timer)
			entry.cleanup()
			entry.reject(error)
		}
	}

	private onReply(line: string): void {
		let id: number
		try {
			const parsed = JSON.parse(line) as { id?: unknown }
			if (typeof parsed.id !== 'number') return
			id = parsed.id
		} catch {
			return
		}
		const entry = this.pending.get(id)
		// An answer to a request nobody awaits (a cancel, a quit, one that timed out).
		if (!entry) return
		this.pending.delete(id)
		clearTimeout(entry.timer)
		entry.cleanup()
		try {
			const reply = decodeReply(entry.op, line)
			if (reply.ok) entry.resolve(reply.body)
			else entry.reject(new A11yError(reply.code, reply.message))
		} catch (error) {
			entry.reject(
				new A11yError(
					'bad_reply',
					error instanceof NativeProtocolError
						? error.message
						: 'the native helper sent a bad line',
				),
			)
		}
	}

	private start(): Promise<boolean> {
		this.starting ??= new Promise<boolean>((resolve) => {
			let channel: NativeChannel
			try {
				channel = (this.options.spawnHelper ?? (() => spawnHelperProcess(this.options)))()
			} catch {
				this.dead = true
				resolve(false)
				return
			}
			this.channel = channel
			this.runs += 1
			let greeted = false
			let greetedAt = 0
			let triedLegacy = false
			const hello = (protocol: string): void =>
				channel.write(
					encodeRequest(this.nextId++, {
						op: 'hello',
						protocol,
						cliVersion: this.options.cliVersion ?? '0.0.0',
					}),
				)
			const fail = (): void => {
				this.dead = true
				this.up = false
				resolve(false)
				channel.kill()
			}
			const timer = setTimeout(fail, this.options.startTimeoutMs ?? 10_000)
			timer.unref?.()
			channel.onExit(() => {
				clearTimeout(timer)
				// Closed, or already replaced: nothing left to do for this one.
				if (this.channel !== channel) {
					resolve(false)
					return
				}
				this.up = false
				this.failAll(new A11yError('helper_exited', 'the native helper ended'))
				// A helper that was running and ended is started again by the next question,
				// a few times; one that never came up stays off.
				// A long, healthy run does not count against the few restarts a session gets.
				if (greeted && Date.now() - greetedAt >= (this.options.stableAfterMs ?? 60_000))
					this.restarts = 0
				if (greeted && !this.closed && this.restarts < (this.options.maxRestarts ?? 3)) {
					this.restarts++
					this.channel = undefined
					this.starting = undefined
				} else this.dead = true
				resolve(false)
			})
			channel.onLine((line) => {
				if (greeted) {
					this.onReply(line)
					return
				}
				try {
					const reply = decodeReply('hello', line)
					// A helper built before the rename knows only the old protocol name.
					if (!reply.ok && reply.code === 'protocol_mismatch' && !triedLegacy) {
						triedLegacy = true
						hello(LEGACY_NATIVE_PROTOCOL)
						return
					}
					greeted = true
					clearTimeout(timer)
					if (!reply.ok) {
						fail()
						return
					}
					this.greeting = reply.body
					this.up = true
					greetedAt = Date.now()
					resolve(true)
				} catch {
					greeted = true
					clearTimeout(timer)
					fail()
				}
			})
			// The helper ids start at 1 and the greeting is the first of them.
			hello(NATIVE_PROTOCOL)
		})
		return this.starting
	}
}
