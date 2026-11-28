import { describe, expect, it } from 'vitest'
import {
	type PillView,
	RECORDING_LIMITS,
	RECORDING_WORDS,
	type RecordingReviewView,
} from '../../shared/recording-protocol.js'
import type { WatchedEvent } from './assembler.js'
import { FakeClock, FakeScheduler, FakeScreen } from './fakes.test.support.js'
import { ContentProtection, type ProtectableWindow } from './protection.js'
import {
	type NarrationHandle,
	type PillOutput,
	RecordingSession,
	type SessionState,
	type WatchSource,
} from './session.js'

class FakeWindow implements ProtectableWindow {
	hidden = false
	setContentProtection(enabled: boolean) {
		this.hidden = enabled
	}
	isDestroyed() {
		return false
	}
}

class FakePill implements PillOutput {
	views: PillView[] = []
	visible = false
	show(view: PillView) {
		this.views.push(view)
		this.visible = true
	}
	hide() {
		this.visible = false
	}
	get last(): PillView | undefined {
		return this.views.at(-1)
	}
}

class FakeWatch implements WatchSource {
	queue: WatchedEvent[] = []
	started = 0
	stopped = 0
	controls = true
	async start() {
		this.started++
		return { controls: this.controls }
	}
	async poll() {
		const events = this.queue
		this.queue = []
		return { events, dropped: 0 }
	}
	async stop() {
		this.stopped++
	}
}

const WALL = new Date(2026, 10, 27, 13, 32, 0).getTime()

function rig(options: { narration?: boolean; watch?: FakeWatch | null } = {}) {
	const clock = new FakeClock()
	const scheduler = new FakeScheduler(clock)
	const screen = new FakeScreen()
	const pill = new FakePill()
	const protection = new ContentProtection()
	const windows = { main: new FakeWindow(), chooser: new FakeWindow(), pill: new FakeWindow() }
	protection.add(windows.main)
	protection.add(windows.chooser)
	protection.add(windows.pill, true)
	const watch = options.watch === null ? undefined : (options.watch ?? new FakeWatch())
	const states: SessionState[] = []
	const reviews: RecordingReviewView[] = []
	const closed: string[] = []
	const messages: string[] = []
	const counts: string[] = []
	const spoken: { say: (t: string, ms: number) => void; gone: () => void }[] = []
	const narrationPushed: number[] = []
	const session = new RecordingSession({
		clock: clock.read,
		wall: () => WALL + clock.now,
		scheduler,
		frames: screen,
		...(watch ? { watch } : {}),
		cursor: () => undefined,
		protection,
		pill,
		...(options.narration
			? {
					narration: (hooks) => {
						spoken.push({ say: hooks.say, gone: hooks.disconnected })
						const handle: NarrationHandle = {
							start: () => undefined,
							push: (samples) => narrationPushed.push(samples.length),
							stop: async () => undefined,
						}
						return handle
					},
				}
			: {}),
		display: { w: 2560, h: 1440, shownW: 1280, shownH: 720 },
		nextId: () => 'rec-1',
		thumb: () => 'data:thumb',
		count: (what) => counts.push(what),
		onState: (state) => states.push(state),
		onReview: (view) => reviews.push(view),
		onReviewClosed: (reason) => closed.push(reason),
		onMessage: (text) => messages.push(text),
	})
	return {
		clock,
		scheduler,
		screen,
		pill,
		protection,
		windows,
		watch,
		session,
		states,
		reviews,
		closed,
		messages,
		counts,
		spoken,
		narrationPushed,
	}
}

const MINUTE = 60_000

describe('starting and the one-at-a-time rule', () => {
	it('records, shows the pill and hides every Namzu window from the pictures', async () => {
		const t = rig()
		await t.session.start({ voice: false })
		expect(t.session.state).toBe('running')
		expect(t.pill.last?.state).toMatchObject({ kind: 'recording', voice: false })
		expect(t.windows.main.hidden).toBe(true)
		expect(t.windows.chooser.hidden).toBe(true)
		expect(t.windows.pill.hidden).toBe(true)
		expect(t.protection.active).toBe(true)
		expect(t.watch?.started).toBe(1)
		expect(t.counts).toEqual(['started'])
	})

	it('refuses a second recording while one runs', async () => {
		const t = rig()
		await t.session.start({ voice: false })
		await expect(t.session.start({ voice: false })).rejects.toThrow(
			'A recording is already running.',
		)
	})

	it('does not record at all when a window cannot be hidden', async () => {
		const t = rig()
		t.protection.add({
			setContentProtection: () => {
				throw new Error('no')
			},
			isDestroyed: () => false,
		})
		await expect(t.session.start({ voice: false })).rejects.toThrow('could not be hidden')
		expect(t.session.state).toBe('idle')
		expect(t.pill.visible).toBe(false)
	})

	it('goes on with pictures and the cursor when the helper cannot subscribe to controls', async () => {
		const watch = new FakeWatch()
		watch.controls = false
		const t = rig({ watch })
		await t.session.start({ voice: false })
		await t.scheduler.advance(4_000)
		expect(t.pill.views.some((view) => view.note === 'typing-not-recorded')).toBe(true)
	})
})

describe('what is heard while recording', () => {
	it('turns helper events into steps and pictures', async () => {
		const t = rig()
		await t.session.start({ voice: false })
		t.screen.fill = 180
		t.watch?.queue.push({ kind: 'invoke', tMs: 1, role: 'Button', name: 'Export' })
		await t.scheduler.advance(2_000)
		await t.session.done()
		expect(t.reviews).toHaveLength(1)
		expect(t.reviews[0]?.steps.map((step) => step.label)).toEqual(['Pressed Button “Export”'])
		expect(t.reviews[0]?.pictureCount).toBeGreaterThanOrEqual(2)
	})

	it('puts the pill into a secure note while a password field has focus', async () => {
		const t = rig()
		await t.session.start({ voice: false })
		t.watch?.queue.push({ kind: 'focus', tMs: 1, role: 'Edit', name: 'Password', secure: true })
		await t.scheduler.advance(500)
		expect(t.pill.views.some((view) => view.note === 'secure-field')).toBe(true)
	})
})

describe('the clock on the pill and the limit', () => {
	it('counts up, and from 9:00 says how long is left', async () => {
		const t = rig()
		await t.session.start({ voice: false })
		await t.scheduler.advance(2 * MINUTE)
		expect(t.pill.last?.state).toMatchObject({ kind: 'recording', elapsedMs: 2 * MINUTE })
		expect((t.pill.last?.state as { leftMs?: number }).leftMs).toBeUndefined()
		await t.scheduler.advance(7 * MINUTE)
		expect(t.pill.last?.state).toMatchObject({
			kind: 'recording',
			elapsedMs: 9 * MINUTE,
			leftMs: MINUTE,
		})
	})

	it('stops itself at 10:00, says so, and opens the review', async () => {
		const t = rig()
		await t.session.start({ voice: false })
		await t.scheduler.advance(RECORDING_LIMITS.maxDurationMs + 500)
		expect(t.session.state).toBe('review')
		expect(t.messages).toContain(RECORDING_WORDS.limitReached)
		expect(t.reviews[0]?.durationMs).toBe(RECORDING_LIMITS.maxDurationMs)
		expect(t.protection.active).toBe(false)
		expect(t.pill.visible).toBe(false)
	})
})

describe('pause, lock and sleep', () => {
	it('pauses without recording the pause, and drops narration audio meanwhile', async () => {
		const t = rig({ narration: true })
		await t.session.start({ voice: true })
		await t.scheduler.advance(2_000)
		t.session.audio(new Float32Array(1_600))
		t.session.pause()
		expect(t.session.state).toBe('paused')
		expect(t.pill.last?.state.kind).toBe('paused')
		t.session.audio(new Float32Array(1_600))
		await t.scheduler.advance(30_000)
		t.session.resume()
		await t.scheduler.advance(1_000)
		await t.session.done()
		expect(t.narrationPushed).toEqual([1_600])
		expect(t.reviews[0]?.durationMs).toBe(3_000)
	})

	it('stops on lock and shows until when it is kept, then resumes within the hour', async () => {
		const t = rig()
		await t.session.start({ voice: false })
		await t.scheduler.advance(5_000)
		t.session.away('lock')
		expect(t.session.state).toBe('away')
		const until = new Date(WALL + t.clock.now + RECORDING_LIMITS.awayKeepMs)
		expect(t.pill.last?.state).toEqual({
			kind: 'away',
			elapsedMs: 5_000,
			keptUntil: `${until.getHours()}:${until.getMinutes().toString().padStart(2, '0')}`,
		})
		await t.scheduler.advance(59 * MINUTE)
		expect(t.session.state).toBe('away')
		t.session.resume()
		expect(t.session.state).toBe('running')
		await t.scheduler.advance(1_000)
		await t.session.done()
		expect(t.reviews[0]?.durationMs).toBe(6_000)
	})

	it('discards after an hour away and says so on the pill', async () => {
		const t = rig()
		await t.session.start({ voice: false })
		t.session.away('sleep')
		await t.scheduler.advance(RECORDING_LIMITS.awayKeepMs + 1_000)
		expect(t.session.state).toBe('idle')
		expect(t.pill.views.some((view) => view.state.kind === 'expired')).toBe(true)
		expect(t.protection.active).toBe(false)
		expect(t.reviews).toHaveLength(0)
		await t.scheduler.advance(10_000)
		expect(t.pill.visible).toBe(false)
	})

	it('ignores lock when nothing is recording', () => {
		const t = rig()
		t.session.away('lock')
		expect(t.session.state).toBe('idle')
	})
})

describe('done, discard and the hold', () => {
	it('opens the review, releases protection and hides the pill on Done', async () => {
		const t = rig()
		await t.session.start({ voice: false })
		await t.scheduler.advance(3_000)
		await t.session.done()
		expect(t.session.state).toBe('review')
		expect(t.windows.main.hidden).toBe(false)
		expect(t.windows.pill.hidden).toBe(true)
		expect(t.pill.visible).toBe(false)
		expect(t.watch?.stopped).toBe(1)
		expect(t.counts).toEqual(['started', 'finished'])
	})

	it('drops a recording on Discard, with no review', async () => {
		const t = rig()
		await t.session.start({ voice: false })
		await t.session.discard()
		expect(t.session.state).toBe('idle')
		expect(t.reviews).toHaveLength(0)
		expect(t.windows.main.hidden).toBe(false)
		expect(t.counts).toEqual(['started', 'discarded'])
	})

	it('expires an unsent recording after 10 minutes and says so', async () => {
		const t = rig()
		await t.session.start({ voice: false })
		await t.session.done()
		await t.scheduler.advance(RECORDING_LIMITS.reviewHoldMs - 1)
		expect(t.session.state).toBe('review')
		await t.scheduler.advance(2)
		expect(t.session.state).toBe('idle')
		expect(t.closed).toEqual(['expired'])
		expect(t.messages).toContain(RECORDING_WORDS.expired)
		expect(t.session.review).toBeUndefined()
	})

	it('lets Send or Discard close the review and stops the hold timer', async () => {
		const t = rig()
		await t.session.start({ voice: false })
		await t.session.done()
		t.session.closeReview('sent')
		expect(t.closed).toEqual(['sent'])
		await t.scheduler.advance(RECORDING_LIMITS.reviewHoldMs * 2)
		expect(t.closed).toEqual(['sent'])
	})

	it('lets a new recording replace one waiting for review', async () => {
		const t = rig()
		await t.session.start({ voice: false })
		await t.session.done()
		await t.session.start({ voice: false })
		expect(t.session.state).toBe('running')
		expect(t.closed).toEqual(['discarded'])
	})

	it('holds a recording until it is sent or dropped, so quitting can warn', async () => {
		const t = rig()
		expect(t.session.holdsRecording).toBe(false)
		await t.session.start({ voice: false })
		expect(t.session.holdsRecording).toBe(true)
		await t.session.done()
		expect(t.session.holdsRecording).toBe(true)
		t.session.closeReview('discarded')
		expect(t.session.holdsRecording).toBe(false)
	})
})

describe('voice', () => {
	it('records what was said with the moment it began', async () => {
		const t = rig({ narration: true })
		await t.session.start({ voice: true })
		await t.scheduler.advance(5_000)
		t.spoken[0]?.say('now I filter the overdue ones', 2_000)
		await t.session.done()
		expect(t.reviews[0]?.voice).toBe('on')
		expect(t.reviews[0]?.steps[0]).toMatchObject({
			label: 'Said “now I filter the overdue ones”',
			t: 2_000,
		})
	})

	it('goes on without voice when narration disconnects, and the pill says so', async () => {
		const t = rig({ narration: true })
		await t.session.start({ voice: true })
		t.spoken[0]?.gone()
		expect(t.pill.last?.note).toBe('narration-disconnected')
		expect(t.session.state).toBe('running')
	})

	it('records without voice and says unavailable when listening is not installed', async () => {
		const t = rig({ narration: false })
		await t.session.start({ voice: true })
		await t.session.done()
		expect(t.reviews[0]?.voice).toBe('unavailable')
	})
})
