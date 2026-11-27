import { describe, expect, it } from 'vitest'
import { RECORDING_LIMITS, type RecordingEvent } from '../../shared/recording-protocol.js'
import {
	type AssemblerNote,
	RecordingAssembler,
	type WatchedEvent,
	changedShare,
	isDeniedWindow,
} from './assembler.js'
import { FakeClock, FakeScreen } from './fakes.test.support.js'

function rig(options: { voice?: 'on' | 'off' } = {}) {
	const clock = new FakeClock()
	const screen = new FakeScreen()
	const notes: AssemblerNote[] = []
	const assembler = new RecordingAssembler({
		clock: clock.read,
		frames: screen,
		display: { w: 2560, h: 1440, shownW: 1280, shownH: 720 },
		voice: options.voice ?? 'off',
		id: 'rec-1',
		note: (note) => notes.push(note),
	})
	/** Moves the clock in 100 ms steps, ticking at each. */
	const run = async (ms: number) => {
		for (let spent = 0; spent < ms; spent += 100) {
			clock.now += 100
			await assembler.tick()
		}
	}
	return { clock, screen, assembler, notes, run }
}

const event = (kind: WatchedEvent['kind'], rest: Partial<WatchedEvent> = {}): WatchedEvent => ({
	kind,
	tMs: 0,
	...rest,
})

describe('the frame policy', () => {
	it('takes a picture at the start and at the end, and points the start and stop events at them', async () => {
		const { assembler, screen, run } = rig()
		await assembler.start()
		await run(2_000)
		screen.fill = 200
		const result = await assembler.finish('done')
		expect(result.events[0]).toMatchObject({
			type: 'start',
			frame: 1,
			display: { w: 2560, h: 1440 },
		})
		const stop = result.events.at(-1)
		expect(stop).toMatchObject({ type: 'stop', reason: 'done' })
		expect(stop?.frame).toBe(result.frames.at(-1)?.index)
		expect(result.frames.length).toBeGreaterThanOrEqual(2)
	})

	it('drops a picture identical to the last one kept', async () => {
		const { assembler, run } = rig()
		await assembler.start()
		await run(10_000)
		expect(assembler.frameCount).toBe(1)
	})

	it('keeps a picture when more than 6 percent of the screen changed, and not for less', async () => {
		const { assembler, screen, run } = rig()
		await assembler.start()
		screen.patch = 0.03
		await run(2_000)
		expect(assembler.frameCount).toBe(1)
		screen.patch = 0.1
		await run(2_000)
		expect(assembler.frameCount).toBe(2)
	})

	it('keeps a picture at least every 5 seconds while the screen keeps changing a little', async () => {
		const { assembler, screen, run } = rig()
		await assembler.start()
		screen.patch = 0.02
		await run(4_000)
		expect(assembler.frameCount).toBe(1)
		await run(2_000)
		expect(assembler.frameCount).toBe(2)
	})

	it('takes a picture 200 ms after a pressed control, tied to the event, not before the minimum gap', async () => {
		const { assembler, screen, clock, run } = rig()
		await assembler.start()
		await run(1_000)
		screen.fill = 150
		assembler.hear([event('invoke', { role: 'Button', name: 'Export' })])
		await run(100)
		expect(assembler.frameCount).toBe(1)
		await run(200)
		expect(assembler.frameCount).toBe(2)
		const result = await assembler.finish('done')
		const invoke = result.events.find((entry) => entry.type === 'invoke')
		expect(invoke).toMatchObject({ role: 'Button', name: 'Export', frame: 2 })
		expect(result.frames.find((frame) => frame.index === 2)?.event).toBe(true)
		expect(clock.now).toBeGreaterThan(0)
	})

	it('waits out the minimum gap between two kept pictures', async () => {
		const { assembler, screen, run } = rig()
		await assembler.start()
		screen.fill = 120
		assembler.hear([event('invoke', { role: 'Button', name: 'A' })])
		await run(300)
		// The start picture was taken at 0 ms: the gap has not passed at 300 ms.
		expect(assembler.frameCount).toBe(1)
		await run(500)
		expect(assembler.frameCount).toBe(2)
	})

	it('takes a picture on a foreground app change and records the app', async () => {
		const { assembler, screen, run } = rig()
		await assembler.start()
		await run(1_000)
		screen.fill = 30
		assembler.hear([event('app', { process: 'sheet.exe', window: 'q3-report.xlsx' })])
		await run(1_000)
		const result = await assembler.finish('done')
		expect(result.events.find((entry) => entry.type === 'app')).toMatchObject({
			name: 'sheet.exe',
			title: 'q3-report.xlsx',
		})
		expect(result.frames.length).toBeGreaterThanOrEqual(2)
	})

	it('draws the ring where the cursor is by handing the source the sampled point', async () => {
		const { assembler, screen, run } = rig()
		await assembler.start()
		assembler.cursor({ x: 400, y: 300 })
		await run(1_000)
		expect(screen.cursors.at(-1)).toEqual({ x: 400, y: 300 })
	})

	it('notes where the pointer settled as a fraction of the display', async () => {
		const { assembler, run } = rig()
		await assembler.start()
		assembler.cursor({ x: 1280, y: 720 })
		await run(600)
		const result = await assembler.finish('done')
		expect(result.events.find((entry) => entry.type === 'pointer')).toMatchObject({
			x: 0.5,
			y: 0.5,
		})
	})
})

describe('what is held and what is not', () => {
	it('holds at most 60 pictures, dropping older ones no event needs and never the first or last', async () => {
		const { assembler, screen, run } = rig()
		await assembler.start()
		for (let step = 0; step < 80; step++) {
			screen.fill = (screen.fill + 37) % 200
			screen.patch = 0.5
			await run(RECORDING_LIMITS.minFrameGapMs + 400)
		}
		const result = await assembler.finish('done')
		expect(result.frames.length).toBeLessThanOrEqual(RECORDING_LIMITS.maxHeldFrames)
		expect(result.frames[0]?.index).toBe(1)
		expect(result.cut.framesHeld).toBeGreaterThan(0)
	})

	it('drops a completely black picture and marks a protected screen once', async () => {
		const { assembler, screen, run } = rig()
		await assembler.start()
		screen.black = true
		await run(3_000)
		screen.black = false
		screen.fill = 60
		await run(2_000)
		const result = await assembler.finish('done')
		const marks = result.events.filter((entry) => entry.type === 'paused')
		expect(marks).toHaveLength(1)
		expect(marks[0]?.reason).toBe('protected-screen')
		expect(result.events.some((entry) => entry.type === 'resumed')).toBe(true)
		expect(result.cut.paused).toBe(1)
	})

	it('keeps the event and says so after three pictures fail in a row', async () => {
		const { assembler, screen, notes, run } = rig()
		await assembler.start()
		screen.failing = true
		assembler.hear([event('invoke', { role: 'Button', name: 'Go' })])
		await run(5_000)
		expect(notes).toContain('screenshots-failing')
		const result = await assembler.finish('done')
		expect(result.events.some((entry) => entry.type === 'invoke')).toBe(true)
		expect(result.cut.frameFailures).toBeGreaterThanOrEqual(3)
	})

	it('removes pauses from recorded time', async () => {
		const { assembler, run, clock } = rig()
		await assembler.start()
		await run(2_000)
		assembler.pause('user')
		clock.now += 30_000
		assembler.resume()
		await run(1_000)
		expect(assembler.elapsed()).toBe(3_000)
		const result = await assembler.finish('done')
		expect(result.durationMs).toBe(3_000)
	})

	it('knows when the 10 minute limit is reached', async () => {
		const { assembler, clock } = rig()
		await assembler.start()
		clock.now = RECORDING_LIMITS.maxDurationMs - 1
		expect(assembler.limitReached()).toBe(false)
		clock.now = RECORDING_LIMITS.maxDurationMs
		expect(assembler.limitReached()).toBe(true)
	})
})

describe('secure fields', () => {
	it('pauses on a secure field, never reads its value, and resumes when focus leaves it', async () => {
		const { assembler, screen, notes, run } = rig()
		await assembler.start()
		await run(1_000)
		assembler.hear([
			event('focus', { role: 'Edit', name: 'Password', secure: true, value: 'hunter2' }),
		])
		expect(assembler.paused).toBe(true)
		expect(notes).toContain('secure-field')
		const before = assembler.frameCount
		screen.fill = 220
		assembler.hear([
			event('value', { role: 'Edit', name: 'Password', secure: true, value: 'hunter22' }),
		])
		await run(3_000)
		expect(assembler.frameCount).toBe(before)
		assembler.hear([event('focus', { role: 'Edit', name: 'Search' })])
		expect(assembler.paused).toBe(false)
		await run(2_000)
		const result = await assembler.finish('done')
		expect(JSON.stringify(result.events)).not.toContain('hunter')
		expect(
			result.events.some((entry) => entry.type === 'paused' && entry.reason === 'secure-field'),
		).toBe(true)
		expect(result.events.some((entry) => entry.type === 'resumed')).toBe(true)
	})

	it('pauses in a password manager and stays paused until another program comes forward', async () => {
		const { assembler, run } = rig()
		await assembler.start()
		assembler.hear([event('app', { process: '1Password.exe', window: 'Vault' })])
		expect(assembler.paused).toBe(true)
		assembler.hear([
			event('focus', { role: 'Edit', name: 'Search', window: 'Vault', process: '1Password.exe' }),
		])
		expect(assembler.paused).toBe(true)
		assembler.hear([event('app', { process: 'sheet.exe', window: 'q3.xlsx' })])
		expect(assembler.paused).toBe(false)
		await run(200)
	})

	it('treats a window titled Password as secure', () => {
		expect(isDeniedWindow({ window: 'Enter your Password' })).toBe(true)
		expect(isDeniedWindow({ process: 'notepad.exe', window: 'notes' })).toBe(false)
	})
})

describe('typed text', () => {
	it('keeps a field’s final text when focus leaves it, never keystrokes', async () => {
		const { assembler, run } = rig()
		await assembler.start()
		assembler.hear([event('focus', { role: 'Edit', name: 'Search' })])
		for (const value of ['o', 'ov', 'overdue', 'overdue invoices'])
			assembler.hear([event('value', { role: 'Edit', name: 'Search', value })])
		assembler.hear([event('focus', { role: 'Edit', name: 'Filter' })])
		await run(100)
		const result = await assembler.finish('done')
		const texts = result.events.filter((entry) => entry.type === 'text')
		expect(texts).toEqual([expect.objectContaining({ field: 'Search', value: 'overdue invoices' })])
	})

	it('settles a still field during recording', async () => {
		const { assembler, run } = rig()
		await assembler.start()
		assembler.hear([event('value', { role: 'Edit', name: 'Note', value: 'hello' })])
		await run(900)
		const result = await assembler.finish('done')
		expect(result.events.find((entry) => entry.type === 'text')).toMatchObject({
			field: 'Note',
			value: 'hello',
		})
	})

	it('cuts a text value to 200 characters and counts the cut', async () => {
		const { assembler } = rig()
		await assembler.start()
		assembler.hear([event('value', { role: 'Edit', name: 'Note', value: 'word '.repeat(80) })])
		const result = await assembler.finish('done')
		const text = result.events.find((entry) => entry.type === 'text')
		expect(text?.value?.length).toBe(RECORDING_LIMITS.maxTextChars)
		expect(result.cut.text).toBe(1)
	})

	it('replaces a secret typed into an ordinary field', async () => {
		const { assembler } = rig()
		await assembler.start()
		assembler.hear([
			event('value', {
				role: 'Edit',
				name: 'Notes',
				value: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
			}),
		])
		const result = await assembler.finish('done')
		const text = result.events.find((entry) => entry.type === 'text')
		expect(text?.value).toBe('token [removed]')
		expect(result.cut.redacted).toBe(1)
	})
})

describe('spoken text', () => {
	it('places a say event at the moment the speech began, in order', async () => {
		const { assembler, run } = rig({ voice: 'on' })
		await assembler.start()
		await run(5_000)
		assembler.hear([event('invoke', { role: 'Button', name: 'Export' })])
		assembler.say('now I filter the overdue ones', 2_000)
		const result = await assembler.finish('done')
		const says = result.events.filter((entry) => entry.type === 'say')
		expect(says[0]).toMatchObject({ t: 2_000, text: 'now I filter the overdue ones' })
		const times = result.events.map((entry) => entry.t)
		expect([...times].sort((a, b) => a - b)).toEqual(times)
		expect(result.voice).toBe('on')
	})

	it('replaces a spoken secret and counts it', async () => {
		const { assembler } = rig({ voice: 'on' })
		await assembler.start()
		assembler.say('the key is sk-abcdef123456 ok')
		const result = await assembler.finish('done')
		expect(result.events.find((entry) => entry.type === 'say')?.text).toBe(
			'the key is [removed] ok',
		)
		expect(result.cut.redacted).toBe(1)
	})

	it('stops adding spoken text after 20 000 characters and says so in the cut', async () => {
		const { assembler } = rig({ voice: 'on' })
		await assembler.start()
		for (let index = 0; index < 8; index++) assembler.say(`${'a '.repeat(1_400)}`.trim())
		const result = await assembler.finish('done')
		const total = result.events
			.filter((entry) => entry.type === 'say')
			.reduce((sum, entry) => sum + (entry.text?.length ?? 0), 0)
		expect(total).toBeLessThanOrEqual(RECORDING_LIMITS.maxSayTotalChars)
		expect(result.cut.say).toBeGreaterThan(0)
	})

	it('splits a long utterance into chunks of at most 4096 characters', async () => {
		const { assembler } = rig({ voice: 'on' })
		await assembler.start()
		assembler.say(`${'word '.repeat(1_500)}`.trim())
		const result = await assembler.finish('done')
		const says = result.events.filter((entry) => entry.type === 'say')
		expect(says.length).toBeGreaterThan(1)
		for (const entry of says) expect(entry.text?.length).toBeLessThanOrEqual(4_096)
	})
})

describe('caps', () => {
	it('stops adding events at 2 000, keeps the start and the stop, and counts what was cut', async () => {
		const { assembler } = rig()
		await assembler.start()
		const burst: WatchedEvent[] = []
		for (let index = 0; index < 2_100; index++)
			burst.push(event('selection', { role: 'ListItem', name: `row ${index}` }))
		assembler.hear(burst)
		const result = await assembler.finish('done')
		expect(result.events.length).toBeLessThanOrEqual(RECORDING_LIMITS.maxEvents)
		expect(result.events[0]?.type).toBe('start')
		expect(result.events.at(-1)?.type).toBe('stop')
		expect(result.cut.events).toBeGreaterThan(0)
	})

	it('cuts names to 80 characters and titles to 120', async () => {
		const { assembler } = rig()
		await assembler.start()
		assembler.hear([
			event('invoke', { role: 'Button', name: 'x'.repeat(300) }),
			event('app', { process: 'a.exe', window: 'y'.repeat(400) }),
		])
		const result = await assembler.finish('done')
		expect(result.events.find((entry) => entry.type === 'invoke')?.name?.length).toBe(80)
		expect(result.events.find((entry) => entry.type === 'app')?.title?.length).toBe(120)
	})

	it('counts the events the helper reported as dropped', async () => {
		const { assembler } = rig()
		await assembler.start()
		assembler.hear([], 7)
		const result = await assembler.finish('done')
		expect(result.cut.helperDropped).toBe(7)
	})
})

describe('controls', () => {
	it('reports that no program exposed its controls when nothing but the foreground was heard', async () => {
		const { assembler, notes } = rig()
		await assembler.start()
		assembler.hear([event('app', { process: 'game.exe' })])
		assembler.noteControls()
		const result = await assembler.finish('done')
		expect(result.controls).toBe(false)
		expect(notes).toContain('typing-not-recorded')
	})

	it('reports controls as available once any control event arrives', async () => {
		const { assembler } = rig()
		await assembler.start()
		assembler.hear([event('invoke', { role: 'Button', name: 'Save' })])
		expect((await assembler.finish('done')).controls).toBe(true)
	})
})

describe('never kept', () => {
	it('has no place in an event for a key, a button or the clipboard', async () => {
		const { assembler } = rig()
		await assembler.start()
		assembler.hear([event('invoke', { role: 'Button', name: 'Save' })])
		const result = await assembler.finish('done')
		const allowed = new Set([
			't',
			'type',
			'role',
			'name',
			'title',
			'field',
			'value',
			'text',
			'phase',
			'frame',
			'x',
			'y',
			'display',
			'reason',
		])
		for (const entry of result.events as RecordingEvent[])
			for (const key of Object.keys(entry)) expect(allowed.has(key), key).toBe(true)
	})
})

describe('changedShare', () => {
	it('is the share of cells that moved by a visible step', () => {
		const a = new Uint8Array(100).fill(10)
		const b = new Uint8Array(100).fill(10)
		for (let index = 0; index < 25; index++) b[index] = 200
		expect(changedShare(a, b)).toBe(0.25)
		expect(changedShare(a, a)).toBe(0)
	})
})
