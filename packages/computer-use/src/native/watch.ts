import type { NativeWinProcessOptions } from './process.js'
import type {
	NativeWatchEvent,
	NativeWatchKind,
	NativeWatchPollReply,
	NativeWatchStartRequest,
} from './protocol.js'
import { type NativeHelper, shareNativeProcess } from './shared.js'

/**
 * The controls a person uses, watched through the native helper without any
 * input hook: which control was invoked, focused or selected, which menu or
 * window opened or closed, what an ordinary edit field says, and which
 * program came to the front.
 *
 * The helper reads these through read-only UI Automation subscriptions. It
 * never registers for the keyboard or the mouse, so nothing here is a key or a
 * button; a password field reports `secure` and never its text.
 */
export type NativeWatchOptions = NativeWinProcessOptions

export type NativeWatchStart = Omit<NativeWatchStartRequest, 'op'>

export interface NativeWatching {
	/** UI Automation subscriptions are in place; false: only the foreground may be watched. */
	readonly controls: boolean
	readonly foreground: boolean
	readonly kinds: readonly NativeWatchKind[]
}

const REQUEST_MS = 5_000

export class NativeWatch {
	private readonly process: NativeHelper
	private started = false

	constructor(options: NativeWatchOptions) {
		this.process = shareNativeProcess(options)
	}

	get running(): boolean {
		return this.started && this.process.isUp
	}

	/** Starts watching. A helper that has no watch (an older one) is an error that says so. */
	async start(options: NativeWatchStart = {}): Promise<NativeWatching> {
		if (!(await this.process.ready())) throw new Error('the native Windows helper did not start')
		const caps = this.process.hello?.caps ?? []
		if (!caps.includes('watch')) {
			throw new Error('the native Windows helper in use cannot watch the controls a person uses')
		}
		const reply = await this.process.request({ op: 'watch.start', ...options }, REQUEST_MS)
		this.started = true
		return { controls: reply.controls, foreground: reply.foreground, kinds: reply.kinds }
	}

	/** What happened since the last poll, and how many events were not kept. */
	async poll(): Promise<NativeWatchPollReply> {
		return this.process.request({ op: 'watch.poll' }, REQUEST_MS)
	}

	/** Takes every subscription down. Safe to call twice. */
	async stop(): Promise<void> {
		if (!this.started) return
		this.started = false
		if (this.process.isUp) await this.process.request({ op: 'watch.stop' }, REQUEST_MS)
	}

	async dispose(): Promise<void> {
		try {
			await this.stop()
		} finally {
			await this.process.close()
		}
	}
}

export type { NativeWatchEvent }
