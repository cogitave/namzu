import { readFileSync, unlinkSync } from 'node:fs'
import type { ForegroundMonitor, MonitorBurstEnd, MonitorState } from '../foreground/types.js'
import { NativeWinProcess, type NativeWinProcessOptions } from './process.js'
import type { NativeForegroundState, NativeMonitorPollReply } from './protocol.js'

/**
 * The foreground monitor on the native helper: it watches for a person's use
 * of keyboard and mouse and for the window in front, without a global hook.
 *
 * The helper learns of input through Raw Input headers, which say that a
 * device class sent something and when, never which key or button; what comes
 * back here is a count. `escapes` is therefore always 0: the helper does not
 * read keys, so it cannot tell Escape from any other key. A person who wants
 * to stop a burst by using the machine does so by input, which the count sees.
 *
 * It replaces the PowerShell monitor (`WindowsInputMonitor`), which installed
 * system-wide low-level keyboard and mouse hooks.
 */
export interface NativeForegroundMonitorOptions extends NativeWinProcessOptions {
	/** The path as the helper reads it (under WSL a Linux path goes through the distro's share). Default: unchanged. */
	readonly toHelperPath?: (path: string) => string
}

const REQUEST_MS = 5_000

/** `0x1a2b` and `w:000000000000_1a2b` name the same window. */
function windowIdOf(hwnd: string): string {
	const hex = hwnd.replace(/^0x/i, '').toLowerCase()
	return `w:${hex.padStart(16, '0')}`
}

function hwndOf(windowId: string): string {
	const m = /^w:([0-9a-f]+)/i.exec(windowId)
	return `0x${(m?.[1] ?? '0').replace(/^0+(?=.)/, '').toUpperCase()}`
}

export class NativeForegroundMonitor implements ForegroundMonitor {
	private readonly process: NativeWinProcess
	private started = false

	constructor(private readonly options: NativeForegroundMonitorOptions) {
		this.process = new NativeWinProcess(options)
	}

	get running(): boolean {
		return this.started && this.process.isUp
	}

	async start(): Promise<void> {
		if (this.started && this.process.isUp) return
		if (!(await this.process.ready())) throw new Error('the native Windows helper did not start')
		const caps = this.process.hello?.caps ?? []
		if (!caps.includes('monitor')) {
			throw new Error('the native Windows helper in use cannot watch for a person at the keyboard')
		}
		const watching = await this.process.request({ op: 'monitor.start' }, REQUEST_MS)
		if (!watching.input) {
			throw new Error('the native Windows helper could not register for keyboard and mouse use')
		}
		this.started = true
	}

	async state(query: { readonly pid?: number } = {}): Promise<MonitorState> {
		const [fg, poll] = await Promise.all([
			this.process.request(
				{ op: 'foreground.get', ...(query.pid !== undefined ? { processId: query.pid } : {}) },
				REQUEST_MS,
			),
			this.process.request({ op: 'monitor.poll' }, REQUEST_MS),
		])
		return stateOf(fg, poll)
	}

	async begin(args: {
		readonly leasePath: string
		readonly token: string
		readonly raise?: string
		readonly idleMs?: number
	}): Promise<MonitorState & { readonly raised?: boolean; readonly refused?: boolean }> {
		const to = this.options.toHelperPath ?? ((p: string) => p)
		const reply = await this.process.request(
			{
				op: 'lease.begin',
				...(args.raise !== undefined ? { windowId: windowIdOf(args.raise), raise: true } : {}),
				...(args.idleMs !== undefined ? { idleMs: args.idleMs } : {}),
				leasePath: to(args.leasePath),
				token: args.token,
			},
			REQUEST_MS,
		)
		const poll = await this.process.request({ op: 'monitor.poll' }, REQUEST_MS)
		return {
			...stateOf(reply, poll),
			refused: reply.refused,
			...(reply.raised !== undefined ? { raised: reply.raised } : {}),
		}
	}

	async end(args: {
		readonly restore: boolean
		readonly keepCursor?: boolean
	}): Promise<MonitorBurstEnd> {
		const reply = await this.process.request(
			{
				op: 'lease.end',
				restore: args.restore,
				...(args.keepCursor ? { keepCursor: true } : {}),
			},
			REQUEST_MS,
		)
		return {
			inputsDuring: reply.inputsDuring ?? 0,
			escapesDuring: 0,
			restoredForeground: reply.restoredForeground,
			restoredCursor: reply.restoredCursor,
			...(reply.restoreNote !== undefined ? { restoreNote: reply.restoreNote } : {}),
			inputMoved: reply.inputMoved,
			frontElevated: reply.frontElevated,
		}
	}

	/** Deletes the lease file when its token still matches. */
	async release(args: { readonly leasePath: string; readonly token: string }): Promise<void> {
		try {
			const record = JSON.parse(readFileSync(args.leasePath, 'utf8')) as { token?: unknown }
			if (record.token === args.token) unlinkSync(args.leasePath)
		} catch {
			// No file, or not ours: nothing to release.
		}
	}

	async dispose(): Promise<void> {
		this.started = false
		await this.process.close()
	}
}

function stateOf(fg: NativeForegroundState, poll: NativeMonitorPollReply): MonitorState {
	return {
		userIdleMs: fg.userIdleMs,
		userInputs: poll.inputs,
		escapes: 0,
		foreground: fg.foreground
			? {
					hwnd: hwndOf(fg.foreground.windowId),
					pid: fg.foreground.processId,
					exe: fg.foreground.exe,
					elevated: fg.foreground.elevated,
					integrity: fg.foreground.integrity,
				}
			: null,
		cursor: fg.cursor,
		desktop: fg.desktop,
		selfElevated: fg.selfElevated,
		selfIntegrity: fg.selfIntegrity,
		inputTick: fg.inputTick,
		...(fg.target ? { target: fg.target } : {}),
	}
}
