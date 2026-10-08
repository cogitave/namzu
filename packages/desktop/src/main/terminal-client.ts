import { EventEmitter } from 'node:events'
import {
	TERMINAL_LIMITS,
	TERMINAL_METHODS,
	TERMINAL_NOTIFICATIONS,
	type TerminalAttachResult,
	type TerminalCreateSpec,
	type TerminalDataNotification,
	type TerminalExitNotification,
	type TerminalInfo,
	type TerminalStatus,
	checkTerminalCreate,
	readTerminalAttach,
	readTerminalCreated,
	readTerminalData,
	readTerminalExit,
	readTerminalId,
	readTerminalList,
	readTerminalStatus,
} from '../shared/terminal-protocol.js'

/** The slice of the host connection this uses. */
export interface TerminalTransport {
	request(method: string, params?: Record<string, unknown>): Promise<unknown>
	on(event: 'frame', listener: (frame: Record<string, unknown>) => void): unknown
	off(event: 'frame', listener: (frame: Record<string, unknown>) => void): unknown
}

/** Output the host has produced beyond what was last delivered, from `expected`. */
export interface TerminalGap {
	terminalId: string
	expected: number
	received: number
}

/**
 * The desktop's end of the host terminal.
 *
 * Every answer and every notification is validated before anything is emitted.
 * Output arrives as chunks addressed by offset: a chunk already delivered is
 * dropped, a chunk that overlaps what was delivered is cut to its new part, and a
 * chunk that starts beyond the next expected offset is a gap, reported as `gap` so
 * the owner re-attaches from the offset it has (the host replays exactly that).
 * Delivered output is acknowledged in batches so the host can pause a program that
 * outruns the view.
 *
 * Events: `data` (TerminalDataNotification), `exit` (TerminalExitNotification),
 * `gap` (TerminalGap, once per terminal until the next attach).
 */
export class TerminalHostClient extends EventEmitter {
	private readonly expected = new Map<string, number>()
	private readonly unacked = new Map<string, number>()
	private readonly gapped = new Set<string>()
	/**
	 * Output that arrived while an attach was in flight. The host answers an attach and then sends
	 * what follows, and the connection can deliver both in one read, so the notification is handled
	 * before the code waiting on the answer runs. It is held until the answer says where it resumes.
	 */
	private readonly held = new Map<string, TerminalDataNotification[]>()
	private readonly listener = (frame: Record<string, unknown>): void => this.onFrame(frame)

	constructor(
		private readonly transport: TerminalTransport,
		private readonly options: { ackEvery?: number } = {},
	) {
		super()
		transport.on('frame', this.listener)
	}

	dispose(): void {
		this.transport.off('frame', this.listener)
		this.expected.clear()
		this.unacked.clear()
		this.gapped.clear()
		this.held.clear()
		this.removeAllListeners()
	}

	async status(): Promise<TerminalStatus> {
		return readTerminalStatus(await this.transport.request(TERMINAL_METHODS.status))
	}

	async create(spec: TerminalCreateSpec): Promise<TerminalInfo> {
		return readTerminalCreated(
			await this.transport.request(TERMINAL_METHODS.create, { ...checkTerminalCreate(spec) }),
		)
	}

	async list(): Promise<TerminalInfo[]> {
		return readTerminalList(await this.transport.request(TERMINAL_METHODS.list))
	}

	/**
	 * Register a view. `fromOffset` is the end of what the view last drew; omitted, or
	 * too old for the host to replay, the answer is a snapshot to rebuild from.
	 */
	async attach(
		terminalId: string,
		viewerId: string,
		options: { fromOffset?: number; writer?: boolean; force?: boolean } = {},
	): Promise<TerminalAttachResult> {
		const id = readTerminalId(terminalId)
		const holding = !this.held.has(id)
		if (holding) this.held.set(id, [])
		let result: TerminalAttachResult
		try {
			result = readTerminalAttach(
				await this.transport.request(TERMINAL_METHODS.attach, {
					terminalId: id,
					viewerId,
					...(options.fromOffset === undefined ? {} : { fromOffset: options.fromOffset }),
					...(options.writer ? { writer: true } : {}),
					...(options.force ? { force: true } : {}),
				}),
			)
			if (result.terminal.id !== id) throw new Error('The host attached a different terminal.')
		} catch (error) {
			if (holding) this.release(id)
			throw error
		}
		this.expected.set(id, Math.max(this.expected.get(id) ?? 0, result.end))
		this.unacked.set(id, 0)
		this.gapped.delete(id)
		if (holding) this.release(id)
		return result
	}

	/** Hand out what was held, in order; chunks the answer already covered are dropped as duplicates. */
	private release(id: string): void {
		const notes = this.held.get(id) ?? []
		this.held.delete(id)
		for (const note of notes) this.onData(note)
	}

	async detach(terminalId: string, viewerId: string): Promise<void> {
		await this.transport.request(TERMINAL_METHODS.detach, {
			terminalId: readTerminalId(terminalId),
			viewerId,
		})
	}

	async write(terminalId: string, viewerId: string, data: string): Promise<void> {
		// Longer input is sent in host-sized pieces, in order.
		for (let at = 0; at < data.length; at += TERMINAL_LIMITS.maxWrite) {
			let end = Math.min(data.length, at + TERMINAL_LIMITS.maxWrite)
			const last = data.charCodeAt(end - 1)
			if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1
			await this.transport.request(TERMINAL_METHODS.write, {
				terminalId: readTerminalId(terminalId),
				viewerId,
				data: data.slice(at, end),
			})
			at = end - TERMINAL_LIMITS.maxWrite
		}
	}

	async resize(terminalId: string, viewerId: string, cols: number, rows: number): Promise<void> {
		await this.transport.request(TERMINAL_METHODS.resize, {
			terminalId: readTerminalId(terminalId),
			viewerId,
			cols,
			rows,
		})
	}

	/** End the whole process tree. The terminal stays listed, ended, with its last screen. */
	async kill(terminalId: string): Promise<void> {
		await this.transport.request(TERMINAL_METHODS.kill, { terminalId: readTerminalId(terminalId) })
	}

	/** End it if it is running and forget it. */
	async close(terminalId: string): Promise<void> {
		const id = readTerminalId(terminalId)
		await this.transport.request(TERMINAL_METHODS.close, { terminalId: id })
		this.expected.delete(id)
		this.unacked.delete(id)
		this.gapped.delete(id)
	}

	/** The offset the next chunk of this terminal must start at, once attached. */
	nextOffset(terminalId: string): number | undefined {
		return this.expected.get(terminalId)
	}

	private onFrame(frame: Record<string, unknown>): void {
		try {
			if (frame.method === TERMINAL_NOTIFICATIONS.data) this.onData(readTerminalData(frame.params))
			else if (frame.method === TERMINAL_NOTIFICATIONS.exit)
				this.emit('exit', readTerminalExit(frame.params) satisfies TerminalExitNotification)
		} catch {
			// A notification that fails validation grants nothing; the view keeps what it has.
		}
	}

	private onData(note: TerminalDataNotification): void {
		const held = this.held.get(note.terminalId)
		if (held) {
			held.push(note)
			return
		}
		const expected = this.expected.get(note.terminalId)
		if (expected === undefined) return
		const end = note.offset + note.data.length
		if (end <= expected) return
		if (note.offset > expected) {
			// Once per terminal: every later chunk is also beyond the gap until the owner re-attaches.
			if (this.gapped.has(note.terminalId)) return
			this.gapped.add(note.terminalId)
			this.emit('gap', {
				terminalId: note.terminalId,
				expected,
				received: note.offset,
			} satisfies TerminalGap)
			return
		}
		const fresh = note.offset < expected ? note.data.slice(expected - note.offset) : note.data
		this.expected.set(note.terminalId, end)
		this.emit('data', { terminalId: note.terminalId, offset: expected, data: fresh })
		const pending = (this.unacked.get(note.terminalId) ?? 0) + fresh.length
		if (pending >= (this.options.ackEvery ?? 65_536)) {
			this.unacked.set(note.terminalId, 0)
			void this.transport
				.request(TERMINAL_METHODS.ack, { terminalId: note.terminalId, offset: end })
				.catch(() => undefined)
		} else this.unacked.set(note.terminalId, pending)
	}
}
