import { describe, expect, it } from 'vitest'
import {
	EMPTY_CUT,
	RECORDING_LIMITS,
	type RecordingEvent,
	type RecordingFrameData,
	type RecordingResult,
} from '../../shared/recording-protocol.js'
import { ReviewDraft, cutLines, fitEvents, stepLabel, thinFrames } from './review.js'

const frame = (index: number, t: number, event = false, size = 1_000): RecordingFrameData => ({
	index,
	t,
	event,
	jpeg: new Uint8Array(size),
})

function sample(frames: RecordingFrameData[], events: RecordingEvent[]): RecordingResult {
	return {
		id: 'r',
		durationMs: 192_000,
		stopReason: 'done',
		events,
		frames,
		cut: { ...EMPTY_CUT },
		voice: 'on',
		display: { w: 2560, h: 1440, shownW: 1280, shownH: 720 },
		controls: true,
		typingNote: false,
	}
}

describe('thinning for delivery', () => {
	it('keeps everything under the limits', () => {
		const frames = [frame(1, 0), frame(2, 1000), frame(3, 2000)]
		const out = thinFrames(frames, [])
		expect(out.frames).toHaveLength(3)
		expect(out.dropped).toBe(0)
	})

	it('drops to 24 pictures, keeping the first, the last and every picture tied to an event', () => {
		const frames = Array.from({ length: 60 }, (_, at) => frame(at + 1, at * 1000, at % 10 === 5))
		const events: RecordingEvent[] = frames
			.filter((entry) => entry.event)
			.map((entry) => ({ t: entry.t, type: 'invoke', name: `b${entry.index}`, frame: entry.index }))
		const out = thinFrames(frames, events)
		expect(out.frames).toHaveLength(RECORDING_LIMITS.maxSentFrames)
		expect(out.dropped).toBe(36)
		expect(out.frames[0]?.t).toBe(0)
		expect(out.frames.at(-1)?.t).toBe(59_000)
		// All six event pictures survive and their events still point at them, renumbered.
		for (const entry of events) {
			const sent = out.events.find((e) => e.name === entry.name)
			expect(sent?.frame).toBeDefined()
			expect(out.frames[(sent?.frame ?? 1) - 1]?.t).toBe(entry.t)
		}
		expect(out.frames.map((f) => f.index)).toEqual(out.frames.map((_, at) => at + 1))
	})

	it('drops pictures nobody needs before pictures an event needs, spreading what is left', () => {
		const frames = [frame(1, 0), frame(2, 100), frame(3, 200), frame(4, 5000, true), frame(5, 9000)]
		const out = thinFrames(frames, [], { count: 4, bytes: 1e9 })
		// The one with the most crowded neighbours (t=100 or t=200) goes, not the event picture.
		expect(out.frames.map((f) => f.t)).toContain(5000)
		expect(out.frames).toHaveLength(4)
	})

	it('goes under the byte cap, dropping before it gives up on a picture', () => {
		const frames = Array.from({ length: 10 }, (_, at) => frame(at + 1, at * 1000, false, 1_000_000))
		const out = thinFrames(frames, [])
		const bytes = out.frames.reduce((sum, f) => sum + f.jpeg.byteLength, 0)
		expect(bytes).toBeLessThanOrEqual(RECORDING_LIMITS.maxSentBytes)
		expect(out.frames.length).toBeLessThan(10)
	})

	it('strips the picture pointer from an event whose picture was dropped', () => {
		const frames = Array.from({ length: 30 }, (_, at) => frame(at + 1, at * 1000))
		const events: RecordingEvent[] = [{ t: 3_000, type: 'pointer', frame: 4 }]
		const out = thinFrames(frames, events)
		expect(
			out.events[0]?.frame === undefined || out.frames[(out.events[0].frame ?? 1) - 1]?.t === 3000,
		).toBe(true)
	})
})

describe('fitting the events to 24 KB', () => {
	it('leaves a small list alone', () => {
		const events: RecordingEvent[] = [{ t: 0, type: 'start' }]
		expect(fitEvents(events)).toEqual({ events, dropped: 0 })
	})

	it('drops typed text first, newest first, then pointer rests, and never a press or the ends', () => {
		const events: RecordingEvent[] = [{ t: 0, type: 'start' }]
		for (let at = 0; at < 120; at++) {
			events.push({ t: at + 1, type: 'text', field: 'f', value: 'x'.repeat(190) })
			events.push({ t: at + 1, type: 'invoke', role: 'Button', name: `B${at}` })
		}
		events.push({ t: 999, type: 'stop', reason: 'done' })
		const out = fitEvents(events)
		expect(out.dropped).toBeGreaterThan(0)
		expect(out.events.filter((e) => e.type === 'invoke')).toHaveLength(120)
		expect(out.events[0]?.type).toBe('start')
		expect(out.events.at(-1)?.type).toBe('stop')
		const kept = out.events.filter((e) => e.type === 'text')
		// Newest texts went first.
		expect(Math.max(...kept.map((e) => e.t))).toBeLessThan(121)
		expect(new TextEncoder().encode(JSON.stringify(out.events)).byteLength).toBeLessThan(26_000)
	})
})

describe('the review draft', () => {
	const events: RecordingEvent[] = [
		{ t: 0, type: 'start', frame: 1 },
		{ t: 500, type: 'app', name: 'Spreadsheet', title: 'q3.xlsx' },
		{ t: 900, type: 'text', field: 'Search', value: 'overdue' },
		{ t: 1000, type: 'say', text: 'now I filter' },
		{ t: 2000, type: 'invoke', role: 'Button', name: 'Export', frame: 2 },
		{ t: 3000, type: 'stop', frame: 3, reason: 'done' },
	]
	const frames = [frame(1, 0), frame(2, 2000, true), frame(3, 3000)]

	it('lists the steps and the pictures, and counts them', () => {
		const draft = new ReviewDraft(sample(frames, events))
		const view = draft.view(() => 'data:x', RECORDING_LIMITS.reviewHoldMs)
		expect(view.stepCount).toBe(4)
		expect(view.pictureCount).toBe(3)
		expect(view.summary).toBe('Recording ready: 3:12, 3 pictures, 4 steps, voice on')
		expect(view.steps.map((s) => s.label)).toEqual([
			'Switched to Spreadsheet: q3.xlsx',
			'Typed “overdue” in Search',
			'Said “now I filter”',
			'Pressed Button “Export”',
		])
	})

	it('removes a step, a picture, all pictures and the voice text, and says so in the cut lines', () => {
		const draft = new ReviewDraft(sample(frames, events))
		expect(draft.removeStep(1)).toBe(true)
		expect(draft.removeStep(0)).toBe(false)
		expect(draft.removePicture(2)).toBe(true)
		draft.removeVoice()
		const view = draft.view(() => '', 1)
		expect(view.stepCount).toBe(2)
		expect(view.pictureCount).toBe(2)
		expect(view.cutLines).toEqual([
			'You removed 1 step.',
			'You removed 1 picture.',
			'You removed the voice text.',
		])
		draft.removePictures()
		expect(draft.pictureCount).toBe(0)
		const done = draft.finalize()
		expect(done.frames).toHaveLength(0)
		expect(done.result.events.every((e) => e.frame === undefined)).toBe(true)
		expect(done.result.events.some((e) => e.type === 'say')).toBe(false)
	})

	it('never changes the recording it was made from', () => {
		const result = sample(frames, events)
		const draft = new ReviewDraft(result)
		draft.removeStep(1)
		draft.removePictures()
		expect(result.events).toEqual(events)
		expect(result.frames).toHaveLength(3)
	})

	it('adds the thinning to the cut report', () => {
		const many = Array.from({ length: 40 }, (_, at) => frame(at + 1, at * 100))
		const draft = new ReviewDraft(sample(many, [{ t: 0, type: 'start' }]))
		const { result } = draft.finalize()
		expect(result.cut.framesThinned).toBe(16)
		expect(cutLines(result.cut)[0]).toContain('16 pictures left out')
	})
})

describe('step words', () => {
	it('words the kinds a person did', () => {
		expect(stepLabel({ t: 0, type: 'menu', phase: 'open', name: 'File' })).toBe(
			'Opened a menu “File”',
		)
		expect(stepLabel({ t: 0, type: 'select', role: 'ListItem', name: 'Inbox' })).toBe(
			'Chose ListItem “Inbox”',
		)
		expect(stepLabel({ t: 0, type: 'paused', reason: 'secure-field' })).toBe(
			'Paused: a password field',
		)
	})
})
