import { RECORDING_LIMITS } from '../../shared/recording-protocol.js'
import { type CapturedFrame, type FrameSource, GRAY_HEIGHT, GRAY_WIDTH } from './assembler.js'
import type { Scheduler } from './session.js'

/** Test doubles only: an injected clock, frame source and scheduler. Nothing here uses real time. */

export class FakeClock {
	now = 0
	readonly read = (): number => this.now
}

/** A screen a test paints: `fill` is the brightness of every cell, `patch` brightens a share of cells. */
export class FakeScreen implements FrameSource {
	fill = 100
	patch = 0
	black = false
	failing = false
	taken = 0
	readonly cursors: ({ x: number; y: number } | undefined)[] = []
	async capture(cursor?: { x: number; y: number }): Promise<CapturedFrame> {
		this.cursors.push(cursor)
		if (this.failing) throw new Error('capture failed')
		this.taken++
		const gray = new Uint8Array(GRAY_WIDTH * GRAY_HEIGHT).fill(this.fill)
		const cells = Math.round(gray.length * this.patch)
		for (let index = 0; index < cells; index++) gray[index] = (this.fill + 120) % 256
		const jpeg = new Uint8Array(1_000).fill(this.fill)
		return { jpeg, gray, black: this.black }
	}
}

/** Timers a test fires by hand, driven by a fake clock. */
export class FakeScheduler implements Scheduler {
	private timers: { at: number; every?: number; fn: () => void; id: number }[] = []
	private ids = 0
	constructor(private readonly clock: FakeClock) {}
	every(ms: number, fn: () => void): () => void {
		const id = ++this.ids
		this.timers.push({ at: this.clock.now + ms, every: ms, fn, id })
		return () => {
			this.timers = this.timers.filter((timer) => timer.id !== id)
		}
	}
	after(ms: number, fn: () => void): () => void {
		const id = ++this.ids
		this.timers.push({ at: this.clock.now + ms, fn, id })
		return () => {
			this.timers = this.timers.filter((timer) => timer.id !== id)
		}
	}
	/** Moves the clock forward `ms`, firing due timers in time order and letting promises settle. */
	async advance(ms: number): Promise<void> {
		const end = this.clock.now + ms
		for (;;) {
			const due = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0]
			if (!due) break
			this.clock.now = Math.max(this.clock.now, due.at)
			if (due.every) due.at += due.every
			else this.timers = this.timers.filter((timer) => timer.id !== due.id)
			due.fn()
			await settle()
		}
		this.clock.now = end
	}
	get pending(): number {
		return this.timers.length
	}
}

/** Lets chained promises run. */
export async function settle(times = 20): Promise<void> {
	for (let index = 0; index < times; index++) await Promise.resolve()
}

export const MIN_GAP = RECORDING_LIMITS.minFrameGapMs
