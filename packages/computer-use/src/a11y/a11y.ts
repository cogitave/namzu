import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { A11Y_BOOTSTRAP, a11yScriptLine } from './a11y-script.js'
import {
	type A11yAction,
	type A11yChangeKind,
	type A11yDisplay,
	A11yError,
	type A11yFingerprint,
	type A11yIdentityRequest,
	type A11yNode,
	type A11yRect,
	type A11yResolution,
	type A11yResolveRequest,
	type A11ySeq,
	type A11ySnapshot,
	type A11ySnapshotRequest,
	type A11yWaitRequest,
	type A11yWaitResult,
	type A11yWindow,
	type AccessibilityBackend,
} from './interface.js'

/** The ends of a started helper; the real one is a child process. */
export interface A11yProcess {
	write(line: string): void
	onLine(handler: (line: string) => void): void
	onExit(handler: () => void): void
	kill(): void
}

export interface WindowsA11yOptions {
	/** Windows PowerShell, as this process starts it. */
	readonly powershell: string
	readonly env?: NodeJS.ProcessEnv
	/** For tests. */
	readonly spawnHelper?: () => A11yProcess
	/** Waiting for the helper to start (it compiles a small library), ms. Default 30 000. */
	readonly startTimeoutMs?: number
}

function spawnPowerShell(options: WindowsA11yOptions): A11yProcess {
	const child = spawn(
		options.powershell,
		[
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-EncodedCommand',
			Buffer.from(A11Y_BOOTSTRAP, 'utf16le').toString('base64'),
		],
		{ env: options.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
	)
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

/** How many times a helper that ended mid-session is started again. */
const MAX_RESTARTS = 1
/** The protocol revision this client speaks. */
const PROTOCOL_VERSION = 1
/** Tokens carry the helper run they came from, so one from before a restart is refused, not misread. */
const EPOCH_SPAN = 2 ** 40
/** The client gives up on a reply this long after the helper should have sent it, ms. */
const BACKSTOP_MS = 1_500

const DEFAULT_REQUEST_MS = 5_000
const DEFAULT_SNAPSHOT_MS = 8_000
const DEFAULT_WAIT_MS = 2_000
const ARM_MS = 9_000

interface Pending {
	readonly resolve: (reply: Record<string, unknown>) => void
	readonly reject: (error: A11yError) => void
	readonly timer: NodeJS.Timeout
	readonly cleanup: () => void
}

/** The helper's window id (an HWND) → the host's string, the same `0x…` form the adapter uses. */
const windowIdOf = (hwnd: number): string => `0x${hwnd.toString(16)}`

function hwndOf(windowId: string): number {
	const text = windowId.trim().toLowerCase()
	const value = /^0x[0-9a-f]+$/.test(text)
		? Number.parseInt(text.slice(2), 16)
		: /^\d+$/.test(text)
			? Number.parseInt(text, 10)
			: Number.NaN
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new A11yError('bad_window_id', 'not a window id this backend handed out')
	return value
}

const num = (value: unknown, fallback = 0): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : fallback
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const records = (value: unknown): Record<string, unknown>[] =>
	Array.isArray(value)
		? value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
		: []

/**
 * {@link AccessibilityBackend} on a Windows desktop (WSL included), answered
 * by one long-lived PowerShell helper that starts on first use and is
 * reused: a question is one line written to it, not a process.
 *
 * It never throws from `ready()`. Everything else rejects with an
 * {@link A11yError} when the helper cannot answer, and the caller is
 * expected to carry on without it (the adapter falls back to its driver).
 * A helper that ends mid-session is started once more by the next question;
 * a second end, or a helper that never came up, leaves it off.
 */
export class WindowsA11yHost implements AccessibilityBackend {
	readonly id = 'windows-uia'

	private proc: A11yProcess | undefined
	private starting: Promise<boolean> | undefined
	private up = false
	private dead = false
	private restarts = 0
	private epoch = 0
	private closed = false
	private nextId = 1
	private readonly pending = new Map<number, Pending>()

	constructor(private readonly options: WindowsA11yOptions) {}

	get isReady(): boolean {
		return this.up && !this.dead && !this.closed
	}

	warm(): void {
		if (!this.dead && !this.closed) void this.start()
	}

	ready(): Promise<boolean> {
		if (this.dead || this.closed) return Promise.resolve(false)
		return this.start()
	}

	async listWindows(
		options: { readonly includeOwned?: boolean } = {},
		signal?: AbortSignal,
	): Promise<readonly A11yWindow[]> {
		const reply = await this.request(
			'windows',
			options.includeOwned ? { includeOwned: true } : {},
			DEFAULT_REQUEST_MS,
			signal,
		)
		return records(reply.windows).map((w) => ({
			windowId: windowIdOf(num(w.hwnd)),
			processId: num(w.pid),
			processName: str(w.process),
			title: str(w.title),
			bounds: { x: num(w.x), y: num(w.y), width: num(w.width), height: num(w.height) },
			minimized: w.minimized === true,
			focused: w.focused === true,
			z: num(w.z),
		}))
	}

	async listDisplays(signal?: AbortSignal): Promise<readonly A11yDisplay[]> {
		const reply = await this.request('displays', {}, DEFAULT_REQUEST_MS, signal)
		return records(reply.displays).map((d) => ({
			id: str(d.id),
			bounds: { x: num(d.x), y: num(d.y), width: num(d.width), height: num(d.height) },
			workArea: {
				x: num(d.workX),
				y: num(d.workY),
				width: num(d.workWidth),
				height: num(d.workHeight),
			},
			scale: num(d.scale, 1),
			primary: d.primary === true,
		}))
	}

	async snapshot(request: A11ySnapshotRequest, signal?: AbortSignal): Promise<A11ySnapshot> {
		const hwnd = hwndOf(request.windowId)
		const timeoutMs = request.timeoutMs ?? DEFAULT_SNAPSHOT_MS
		const reply = await this.request(
			'snapshot',
			{
				hwnd,
				timeoutMs,
				...(request.maxNodes !== undefined ? { maxNodes: request.maxNodes } : {}),
				...(request.maxDepth !== undefined ? { maxDepth: request.maxDepth } : {}),
				...(request.skeleton ? { skeleton: true } : {}),
				...(request.allowChromium ? { allowChromium: true } : {}),
			},
			timeoutMs,
			signal,
		)
		return {
			windowId: windowIdOf(hwnd),
			revision: num(reply.rev),
			nodes: records(reply.nodes).map(toNode),
			total: num(reply.total),
			truncated: reply.truncated === true,
			skeleton: reply.skeleton === true,
			readMs: num(reply.readMs),
		}
	}

	async seq(windowId?: string, signal?: AbortSignal): Promise<A11ySeq> {
		const reply = await this.request(
			'seq',
			windowId === undefined ? {} : { hwnd: hwndOf(windowId) },
			windowId === undefined ? DEFAULT_REQUEST_MS : ARM_MS,
			signal,
		)
		return this.epoch * EPOCH_SPAN + num(reply.seq)
	}

	async waitForChange(request: A11yWaitRequest, signal?: AbortSignal): Promise<A11yWaitResult> {
		const hwnd = hwndOf(request.windowId)
		const timeoutMs = request.timeoutMs ?? DEFAULT_WAIT_MS
		let since: number | undefined
		if (request.since !== undefined) {
			if (Math.floor(request.since / EPOCH_SPAN) !== this.epoch)
				throw new A11yError('stale_seq', 'the helper restarted since this marker was taken')
			since = request.since % EPOCH_SPAN
		}
		const reply = await this.request(
			'wait_change',
			{
				hwnd,
				timeoutMs,
				...(request.quietMs !== undefined ? { quietMs: request.quietMs } : {}),
				...(since !== undefined ? { since } : {}),
				...(request.kinds ? { kinds: [...request.kinds] satisfies A11yChangeKind[] } : {}),
			},
			// The helper answers within the wait plus a few ms; the client's own limit is the backstop.
			Math.min(timeoutMs, 10_000),
			signal,
		)
		if (reply.changed === true)
			return {
				changed: true,
				settled: reply.settled === true,
				firstEventMs: num(reply.firstEventMs),
				settledMs: num(reply.settledMs),
				events: num(reply.events),
				newWindows: (Array.isArray(reply.newWindows) ? reply.newWindows : [])
					.filter((h): h is number => typeof h === 'number')
					.map(windowIdOf),
			}
		return { changed: false, timedOut: true, settledMs: num(reply.settledMs) }
	}

	async identity(request: A11yIdentityRequest, signal?: AbortSignal): Promise<A11yFingerprint> {
		const reply = await this.request(
			'identity',
			{
				hwnd: hwndOf(request.windowId),
				index: request.index,
				...(request.revision !== undefined ? { rev: request.revision } : {}),
			},
			DEFAULT_SNAPSHOT_MS,
			signal,
		)
		const f = (reply.fingerprint ?? {}) as Record<string, unknown>
		return {
			runtimeId: str(f.runtimeId),
			automationId: str(f.automationId),
			role: str(f.role),
			nameHash: str(f.nameHash),
			parentPath: str(f.parentPath),
			ordinal: num(f.ordinal),
			processStart: num(f.processStart),
		}
	}

	async resolve(request: A11yResolveRequest, signal?: AbortSignal): Promise<A11yResolution> {
		const reply = await this.request(
			'resolve',
			{ hwnd: hwndOf(request.windowId), fingerprint: request.fingerprint },
			DEFAULT_SNAPSHOT_MS,
			signal,
		)
		if (reply.found === true) {
			const via = reply.via
			return {
				found: true,
				index: num(reply.index),
				via: via === 'runtimeId' || via === 'automationId' ? via : 'name',
				revision: num(reply.rev),
			}
		}
		return {
			found: false,
			code: reply.code === 'ambiguous' ? 'ambiguous' : 'not_found',
			...(typeof reply.candidates === 'number' ? { candidates: reply.candidates } : {}),
		}
	}

	async close(): Promise<void> {
		this.closed = true
		const proc = this.proc
		this.proc = undefined
		this.up = false
		this.failAll(new A11yError('closed', 'the accessibility host was closed'))
		if (proc) {
			try {
				proc.write(JSON.stringify({ id: 0, cmd: 'quit' }))
			} catch {
				// Already gone.
			}
			proc.kill()
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

	private async request(
		cmd: string,
		payload: Record<string, unknown>,
		limitMs: number,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		if (signal?.aborted) throw new A11yError('aborted', 'cancelled')
		if (!(await this.ready())) throw new A11yError('unavailable', 'the accessibility host is off')
		const proc = this.proc
		if (!proc || !this.up) throw new A11yError('helper_exited', 'the accessibility host ended')
		const id = this.nextId++
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const onAbort = (): void => {
				if (this.pending.delete(id)) {
					clearTimeout(timer)
					reject(new A11yError('aborted', 'cancelled'))
				}
			}
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) {
					signal?.removeEventListener('abort', onAbort)
					reject(new A11yError('timeout', `the accessibility host did not answer ${cmd}`))
				}
			}, limitMs + BACKSTOP_MS)
			timer.unref?.()
			signal?.addEventListener('abort', onAbort, { once: true })
			this.pending.set(id, {
				resolve,
				reject,
				timer,
				cleanup: () => signal?.removeEventListener('abort', onAbort),
			})
			proc.write(JSON.stringify({ id, cmd, ...payload }))
		})
	}

	private onReply(line: string): void {
		let reply: Record<string, unknown>
		try {
			reply = JSON.parse(line) as Record<string, unknown>
		} catch {
			return
		}
		const id = reply.id
		if (typeof id !== 'number') return
		const entry = this.pending.get(id)
		if (!entry) return
		this.pending.delete(id)
		clearTimeout(entry.timer)
		entry.cleanup()
		if (reply.ok === true) entry.resolve(reply)
		else
			entry.reject(
				new A11yError(
					typeof reply.code === 'string' ? reply.code : 'error',
					typeof reply.message === 'string' ? reply.message : 'the accessibility host failed',
				),
			)
	}

	private start(): Promise<boolean> {
		this.starting ??= new Promise<boolean>((resolve) => {
			let proc: A11yProcess
			try {
				proc = (this.options.spawnHelper ?? (() => spawnPowerShell(this.options)))()
			} catch {
				this.dead = true
				resolve(false)
				return
			}
			this.proc = proc
			this.epoch += 1
			let greeted = false
			const fail = (): void => {
				this.dead = true
				this.up = false
				resolve(false)
				proc.kill()
			}
			const timer = setTimeout(fail, this.options.startTimeoutMs ?? 30_000)
			timer.unref?.()
			proc.onExit(() => {
				clearTimeout(timer)
				// Closed, or already replaced: nothing left to do for this one.
				if (this.proc !== proc) {
					resolve(false)
					return
				}
				this.up = false
				this.failAll(new A11yError('helper_exited', 'the accessibility host ended'))
				// A helper that was running and ended is started again by the next question, once;
				// one that never came up, or ends again, stays off.
				if (greeted && !this.closed && this.restarts < MAX_RESTARTS) {
					this.restarts++
					this.proc = undefined
					this.starting = undefined
				} else this.dead = true
				resolve(false)
			})
			proc.onLine((line) => {
				if (greeted) {
					this.onReply(line)
					return
				}
				greeted = true
				clearTimeout(timer)
				let hello: { ok?: boolean; hello?: boolean; version?: number }
				try {
					hello = JSON.parse(line) as typeof hello
				} catch {
					fail()
					return
				}
				if (hello.ok !== true || hello.hello !== true || hello.version !== PROTOCOL_VERSION) fail()
				else {
					this.up = true
					resolve(true)
				}
			})
			proc.write(a11yScriptLine())
		})
		return this.starting
	}
}

function rect(value: unknown): A11yRect {
	const r = Array.isArray(value) ? value : []
	return { x: num(r[0]), y: num(r[1]), width: num(r[2]), height: num(r[3]) }
}

function toNode(n: Record<string, unknown>): A11yNode {
	const toggle = n.toggle
	const expand = n.expand
	return {
		index: num(n.index),
		parent: num(n.parent, -1),
		depth: num(n.depth),
		role: str(n.role),
		...(typeof n.name === 'string' ? { name: n.name } : {}),
		...(typeof n.automationId === 'string' ? { automationId: n.automationId } : {}),
		...(typeof n.className === 'string' ? { className: n.className } : {}),
		bounds: rect(n.rect),
		enabled: n.enabled !== false,
		offscreen: n.offscreen === true,
		focused: n.focused === true,
		actions: (Array.isArray(n.actions) ? n.actions : []).filter(
			(a): a is A11yAction => typeof a === 'string',
		),
		...(typeof n.value === 'string' ? { value: n.value } : {}),
		...(toggle === 'on' || toggle === 'off' || toggle === 'mixed' ? { toggle } : {}),
		...(expand === 'expanded' || expand === 'collapsed' || expand === 'partial' || expand === 'leaf'
			? { expand }
			: {}),
		...(typeof n.selected === 'boolean' ? { selected: n.selected } : {}),
		...(typeof n.childCount === 'number' ? { childCount: n.childCount } : {}),
	}
}
