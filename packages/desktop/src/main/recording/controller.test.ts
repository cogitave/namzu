import { describe, expect, it } from 'vitest'
import {
	type ChooserAnswer,
	type ChooserInit,
	RECORDING_LIMITS,
	RECORDING_WORDS,
	type RecordingNotice,
} from '../../shared/recording-protocol.js'
import { type ControllerDeps, type DisplaySource, RecordingController } from './controller.js'
import { FakeClock, FakeScheduler, FakeScreen, settle } from './fakes.test.support.js'
import { DEFAULT_CLOSING, SAVE_INSTRUCTION } from './message.js'
import { ContentProtection } from './protection.js'
import type { PillOutput } from './session.js'

function rig(over: Partial<ControllerDeps> = {}, voice = false) {
	const clock = new FakeClock()
	const scheduler = new FakeScheduler(clock)
	const screen = new FakeScreen()
	const notices: RecordingNotice[] = []
	const choosers: ChooserInit[] = []
	let answer: ChooserAnswer = {
		type: 'start',
		displayId: 'd1',
		voice: false,
		microphone: '',
	}
	const saved: unknown[] = []
	const protection = new ContentProtection()
	const pill: PillOutput = { show: () => undefined, hide: () => undefined }
	let placed = 0
	const display: DisplaySource = {
		info: {
			id: 'd1',
			label: 'Display 1',
			width: 2560,
			height: 1440,
			thumb: 'data:image/png;base64,AAAA',
			primary: true,
			underCursor: true,
		},
		width: 2560,
		height: 1440,
		shownWidth: 1280,
		shownHeight: 720,
		frames: () => screen,
		cursor: () => undefined,
		place: () => {
			placed++
		},
	}
	const deps: ControllerDeps = {
		platform: 'win32',
		env: { SESSIONNAME: 'Console' },
		helperPresent: () => true,
		settings: () => ({ enabled: true, voice: false }),
		saveSettings: (patch) => saved.push(patch),
		listening: async () => ({ ready: voice }),
		displays: async () => [display],
		createWatch: () => undefined,
		chooser: async (init) => {
			choosers.push(init)
			return answer
		},
		pill,
		protection,
		shortcut: () => 'Ctrl+Shift+Esc',
		notify: (notice) => notices.push(notice),
		thumb: () => 'data:thumb',
		clock: clock.read,
		wall: () => Date.UTC(2026, 10, 27),
		scheduler,
		nextId: () => 'rec-1',
		...over,
	}
	return {
		controller: new RecordingController(deps),
		clock,
		scheduler,
		notices,
		choosers,
		saved,
		setAnswer: (next: ChooserAnswer) => {
			answer = next
		},
		placed: () => placed,
	}
}

describe('offering the recorder', () => {
	it('is available on native Windows with the helper and the switch on', () => {
		expect(rig().controller.availability()).toEqual({ available: true })
	})

	it('says why not in a remote session, and refuses to begin', async () => {
		const t = rig({ env: { SESSIONNAME: 'RDP-Tcp#3' } })
		expect(t.controller.availability().reason).toBe('remote-session')
		expect(await t.controller.begin({ provider: 'X' })).toEqual({
			started: false,
			reason: 'unavailable',
			message: RECORDING_WORDS.remote,
		})
		expect(t.choosers).toHaveLength(0)
	})

	it.each([
		['platform', { platform: 'linux' as const }],
		['helper-missing', { helperPresent: () => false }],
		['switched-off', { settings: () => ({ enabled: false, voice: false }) }],
	])('hides the item for %s', (reason, over) => {
		expect(rig(over).controller.availability().reason).toBe(reason)
	})
})

describe('the chooser', () => {
	it('says what is recorded and where it goes, and shows the end shortcut', async () => {
		const t = rig()
		await t.controller.begin({ provider: 'DeepSeek V4 Flash' })
		const init = t.choosers[0]
		expect(init?.disclosure).toContain('goes to DeepSeek V4 Flash as a message you can read first')
		expect(init?.warning).toBe(RECORDING_WORDS.warning)
		expect(init?.shortcut).toBe('Ctrl+Shift+Esc')
		expect(init?.inputProtectionMs).toBe(300)
		expect(init?.displays).toHaveLength(1)
	})

	it('offers voice only when listening is downloaded, and says what it understands', async () => {
		const off = rig({}, false)
		await off.controller.begin({ provider: 'X' })
		expect(off.choosers[0]?.voice).toMatchObject({ available: false, on: false })
		expect(off.choosers[0]?.voiceMissing).toBe('Download listening in Settings to use your voice.')
		const on = rig(
			{
				listening: async () => ({
					ready: true,
					language: 'Turkish and English',
				}),
				settings: () => ({ enabled: true, voice: true }),
			},
			true,
		)
		await on.controller.begin({ provider: 'X' })
		expect(on.choosers[0]?.voice).toMatchObject({
			available: true,
			on: true,
			language: 'Voice narration understands Turkish and English.',
		})
	})

	it('records nothing and takes no protection when the person cancels', async () => {
		const t = rig()
		t.setAnswer({ type: 'cancel' })
		expect(await t.controller.begin({ provider: 'X' })).toEqual({
			started: false,
			reason: 'cancelled',
		})
		expect(t.controller.state).toBe('idle')
		expect(t.saved).toEqual([])
	})

	it('remembers the voice and microphone choice, and starts', async () => {
		const t = rig({}, true)
		t.setAnswer({ type: 'start', displayId: 'd1', voice: true, microphone: 'm1' })
		expect(await t.controller.begin({ provider: 'X' })).toEqual({ started: true })
		expect(t.saved).toEqual([{ screenRecordingVoice: true }])
		expect(t.placed()).toBe(1)
		expect(t.controller.state).toBe('running')
	})

	it('refuses a second recording while one runs', async () => {
		const t = rig()
		await t.controller.begin({ provider: 'X' })
		const again = await t.controller.begin({ provider: 'X' })
		expect(again).toEqual({
			started: false,
			reason: 'busy',
			message: RECORDING_WORDS.alreadyRunning,
		})
	})

	it('goes through the permission step again after Continue', async () => {
		const t = rig()
		let calls = 0
		const t2 = rig({
			chooser: async () => {
				calls++
				return calls === 1
					? { type: 'continue' }
					: { type: 'start', displayId: 'd1', voice: false, microphone: '' }
			},
		})
		expect(await t2.controller.begin({ provider: 'X' })).toEqual({ started: true })
		expect(calls).toBe(2)
		expect(t.controller.state).toBe('idle')
	})
})

describe('review, send and discard', () => {
	async function recorded() {
		const t = rig()
		await t.controller.begin({ provider: 'X' })
		await t.scheduler.advance(3_000)
		await t.controller.act('done')
		return t
	}

	it('opens the review when Done is pressed', async () => {
		const t = await recorded()
		expect(t.notices.some((notice) => notice.type === 'review')).toBe(true)
		expect(t.controller.review()?.summary).toContain('Recording ready: 0:03')
	})

	it('hands the composer one attachment and the default closing paragraph, and nothing earlier', async () => {
		const t = await recorded()
		const before = t.notices.length
		const sent = t.controller.send(undefined)
		expect(sent.attachment.name).toBe('Screen recording 0:03')
		expect(sent.attachment.text.startsWith('<screen-recording version="1"')).toBe(true)
		expect(sent.attachment.images.length).toBeGreaterThanOrEqual(1)
		expect(sent.composerText).toBe(DEFAULT_CLOSING)
		expect(t.notices.slice(before)).toContainEqual({ type: 'review-closed', reason: 'sent' })
		expect(() => t.controller.send(undefined)).toThrow(RECORDING_WORDS.expired)
	})

	it('carries the person’s note, and the save instruction stays', async () => {
		const t = await recorded()
		const sent = t.controller.send('make this a weekly report skill')
		expect(sent.composerText.startsWith('make this a weekly report skill')).toBe(true)
		expect(sent.composerText.endsWith(SAVE_INSTRUCTION)).toBe(true)
	})

	it('leaves out pictures and voice text the person removed, and says what was removed', async () => {
		const t = await recorded()
		expect(t.controller.removePictures()?.pictureCount).toBe(0)
		const view = t.controller.review()
		expect(view?.cutLines.join(' ')).toContain('You removed')
		const sent = t.controller.send(undefined)
		expect(sent.attachment.images).toEqual([])
		expect(sent.attachment.text).toContain('images="0"')
		expect(sent.attachment.text).toContain('No pictures were included.')
	})

	it('drops the recording on Discard', async () => {
		const t = await recorded()
		t.controller.discardReview()
		expect(t.controller.review()).toBeUndefined()
		expect(() => t.controller.send(undefined)).toThrow()
		expect(t.notices).toContainEqual({ type: 'review-closed', reason: 'discarded' })
	})

	it('expires an unsent recording after ten minutes', async () => {
		const t = await recorded()
		await t.scheduler.advance(RECORDING_LIMITS.reviewHoldMs + 1)
		expect(t.notices).toContainEqual({ type: 'review-closed', reason: 'expired' })
		expect(t.notices).toContainEqual({ type: 'message', text: RECORDING_WORDS.expired })
	})
})

describe('ending from anywhere', () => {
	it('ends through the shortcut and goes to review', async () => {
		const t = rig()
		await t.controller.begin({ provider: 'X' })
		await t.scheduler.advance(1_000)
		await t.controller.endNow()
		expect(t.controller.state).toBe('review')
	})

	it('holds the recording so quitting can say so', async () => {
		const t = rig()
		expect(t.controller.holdsRecording).toBe(false)
		await t.controller.begin({ provider: 'X' })
		expect(t.controller.holdsRecording).toBe(true)
	})

	it('finishes what exists when a display goes away', async () => {
		const t = rig()
		await t.controller.begin({ provider: 'X' })
		await t.scheduler.advance(1_000)
		t.controller.displayLost()
		await settle(100)
		expect(t.controller.state).toBe('review')
	})
})
