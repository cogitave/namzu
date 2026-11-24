/**
 * {@link AccessibilityBackend} answered by the native Windows helper.
 *
 * It says what {@link WindowsA11yHost} says (the same interface, the same
 * limits, the same change-marker contract) but asks a compiled program that
 * calls UI Automation directly, instead of a PowerShell process that
 * compiles C# at its first use. Only the process behind it changes; a caller
 * that held the PowerShell host holds this one the same way.
 *
 * Window ids: the host's callers know a window as `0x<handle>` (the form the
 * adapter reports); the helper names one `w:<handle>:<process>`. This class
 * translates both ways, remembering the process of every window it has been
 * told about so a later id carries it.
 */

import {
	type A11yDisplay,
	A11yError,
	type A11yFingerprint,
	type A11yIdentityRequest,
	type A11yNode,
	type A11yResolution,
	type A11yResolveRequest,
	type A11ySeq,
	type A11ySnapshot,
	type A11ySnapshotRequest,
	type A11yWaitRequest,
	type A11yWaitResult,
	type A11yWindow,
	type AccessibilityBackend,
} from '../a11y/interface.js'
import { NativeWinProcess, type NativeWinProcessOptions } from './process.js'
import type { NativeNode } from './protocol.js'

/** Tokens carry the helper run they came from, so one from before a restart is refused, not misread. */
const EPOCH_SPAN = 2 ** 40

const DEFAULT_REQUEST_MS = 5_000
const DEFAULT_SNAPSHOT_MS = 8_000
const DEFAULT_WAIT_MS = 2_000
const ARM_MS = 9_000

/** The handle in a helper window id, or in the host's `0x…` form. */
function handleOf(windowId: string): number {
	const text = windowId.trim().toLowerCase()
	const helper = /^w:([0-9a-f]{1,16})(?::\d+)?$/.exec(text)
	const value = helper
		? Number.parseInt(helper[1] as string, 16)
		: /^0x[0-9a-f]+$/.test(text)
			? Number.parseInt(text.slice(2), 16)
			: /^\d+$/.test(text)
				? Number.parseInt(text, 10)
				: Number.NaN
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new A11yError('bad_window_id', 'not a window id this backend handed out')
	return value
}

/** The id callers hold: `0x…`, the form the adapter uses. */
const hostIdOf = (handle: number): string => `0x${handle.toString(16)}`

const num = (value: number | undefined, fallback = 0): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : fallback

function toNode(n: NativeNode): A11yNode {
	const { ref: _ref, ...node } = n
	return node as A11yNode
}

export class NativeA11yBackend implements AccessibilityBackend {
	readonly id = 'native-uia'

	private readonly process: NativeWinProcess
	/** Window handle to the process that owned it when last listed or named. */
	private readonly processes = new Map<number, number>()

	constructor(options: NativeWinProcessOptions) {
		this.process = new NativeWinProcess(options)
	}

	get isReady(): boolean {
		return this.process.isUp
	}

	warm(): void {
		this.process.warm()
	}

	release(): void {
		this.process.release()
	}

	ready(): Promise<boolean> {
		return this.process.ready()
	}

	async listWindows(
		options: { readonly includeOwned?: boolean } = {},
		signal?: AbortSignal,
	): Promise<readonly A11yWindow[]> {
		const reply = await this.process.request(
			{ op: 'windows', ...(options.includeOwned ? { includeOwned: true } : {}) },
			DEFAULT_REQUEST_MS,
			signal,
		)
		return reply.windows.map((w) => {
			const handle = handleOf(w.windowId)
			this.processes.set(handle, w.processId)
			return { ...w, windowId: hostIdOf(handle) }
		})
	}

	async listDisplays(signal?: AbortSignal): Promise<readonly A11yDisplay[]> {
		const reply = await this.process.request({ op: 'displays' }, DEFAULT_REQUEST_MS, signal)
		return reply.displays
	}

	async snapshot(request: A11ySnapshotRequest, signal?: AbortSignal): Promise<A11ySnapshot> {
		const handle = handleOf(request.windowId)
		const timeoutMs = request.timeoutMs ?? DEFAULT_SNAPSHOT_MS
		const reply = await this.process.request(
			{
				op: 'snapshot',
				windowId: this.helperIdOf(handle),
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
			windowId: hostIdOf(handle),
			revision: reply.revision,
			nodes: reply.nodes.map(toNode),
			total: reply.total,
			truncated: reply.truncated,
			skeleton: reply.skeleton,
			readMs: reply.readMs,
		}
	}

	async seq(windowId?: string, signal?: AbortSignal): Promise<A11ySeq> {
		const reply = await this.process.request(
			windowId === undefined
				? { op: 'seq' }
				: { op: 'seq', windowId: this.helperIdOf(handleOf(windowId)) },
			windowId === undefined ? DEFAULT_REQUEST_MS : ARM_MS,
			signal,
		)
		return this.process.epoch * EPOCH_SPAN + reply.seq
	}

	async waitForChange(request: A11yWaitRequest, signal?: AbortSignal): Promise<A11yWaitResult> {
		const handle = handleOf(request.windowId)
		const timeoutMs = request.timeoutMs ?? DEFAULT_WAIT_MS
		let since: number | undefined
		if (request.since !== undefined) {
			if (Math.floor(request.since / EPOCH_SPAN) !== this.process.epoch)
				throw new A11yError('stale_seq', 'the helper restarted since this marker was taken')
			since = request.since % EPOCH_SPAN
		}
		const reply = await this.process.request(
			{
				op: 'wait_change',
				windowId: this.helperIdOf(handle),
				timeoutMs,
				...(request.quietMs !== undefined ? { quietMs: request.quietMs } : {}),
				...(since !== undefined ? { since } : {}),
				...(request.kinds ? { kinds: [...request.kinds] } : {}),
			},
			// The helper answers within the wait plus a few ms; the client's own limit is the backstop.
			Math.min(timeoutMs, 10_000),
			signal,
		)
		if (!reply.changed) return { changed: false, timedOut: true, settledMs: num(reply.settledMs) }
		return {
			changed: true,
			settled: reply.settled,
			firstEventMs: reply.firstEventMs,
			settledMs: reply.settledMs,
			events: reply.events,
			newWindows: reply.newWindows.map((id) => hostIdOf(this.remember(id))),
		}
	}

	async identity(request: A11yIdentityRequest, signal?: AbortSignal): Promise<A11yFingerprint> {
		const reply = await this.process.request(
			{
				op: 'identity',
				windowId: this.helperIdOf(handleOf(request.windowId)),
				index: request.index,
				...(request.revision !== undefined ? { revision: request.revision } : {}),
			},
			DEFAULT_SNAPSHOT_MS,
			signal,
		)
		return reply.fingerprint
	}

	async resolve(request: A11yResolveRequest, signal?: AbortSignal): Promise<A11yResolution> {
		return this.process.request(
			{
				op: 'resolve',
				windowId: this.helperIdOf(handleOf(request.windowId)),
				fingerprint: request.fingerprint,
			},
			DEFAULT_SNAPSHOT_MS,
			signal,
		)
	}

	close(): Promise<void> {
		return this.process.close()
	}

	/** The helper's id for a window handle: with its process when this backend knows it. */
	private helperIdOf(handle: number): string {
		const hex = handle.toString(16).padStart(16, '0')
		const pid = this.processes.get(handle)
		return pid === undefined ? `w:${hex}` : `w:${hex}:${pid}`
	}

	/** Reads a helper id, keeps its process and returns its handle. */
	private remember(helperId: string): number {
		const handle = handleOf(helperId)
		const pid = /:(\d+)$/.exec(helperId)?.[1]
		if (pid !== undefined) this.processes.set(handle, Number.parseInt(pid, 10))
		return handle
	}
}
