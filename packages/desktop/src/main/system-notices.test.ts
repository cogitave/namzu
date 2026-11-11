import { describe, expect, it } from 'vitest'
import { FINISHED_NOTICE_AFTER_MS } from '../shared/settings-protocol.js'
import {
	FOLD_MS,
	NOTICE_SENTENCES,
	type NoticePayload,
	type NoticeSettings,
	SystemNotices,
} from './system-notices.js'

function setup(initial: Partial<NoticeSettings> = {}, finishedAfterMs?: number, foldMs?: number) {
	let clock = 1_000_000
	let focused = false
	let supported = true
	const settings: NoticeSettings = {
		needsYou: true,
		failed: true,
		finished: true,
		sound: false,
		...initial,
	}
	const shown: { payload: NoticePayload; click: () => void; closed: boolean }[] = []
	const opened: string[] = []
	const timers: { at: number; run: () => void; live: boolean }[] = []
	const names: Record<string, string> = { a: 'Alpha', b: 'Beta', c: 'Gamma' }
	const notices = new SystemNotices({
		supported: () => supported,
		windowFocused: () => focused,
		show: (payload, click) => {
			const record = { payload, click, closed: false }
			shown.push(record)
			return {
				close: () => {
					record.closed = true
				},
			}
		},
		now: () => clock,
		...(finishedAfterMs === undefined ? {} : { finishedAfterMs: () => finishedAfterMs }),
		...(foldMs === undefined ? {} : { foldMs: () => foldMs }),
		schedule: (ms, run) => {
			const timer = { at: clock + ms, run, live: true }
			timers.push(timer)
			return () => {
				timer.live = false
			}
		},
		settings: () => ({ ...settings }),
		projectName: (id) => names[id],
		open: (id) => opened.push(id),
	})
	const advance = (ms: number) => {
		clock += ms
		for (const timer of timers) {
			if (timer.live && timer.at <= clock) {
				timer.live = false
				timer.run()
			}
		}
	}
	return {
		notices,
		shown,
		opened,
		settings,
		advance,
		focus: (value: boolean) => {
			focused = value
			if (value) notices.focused()
		},
		support: (value: boolean) => {
			supported = value
		},
	}
}

const LONG = FINISHED_NOTICE_AFTER_MS + 1

describe('system notices', () => {
	it('says the project name and the fixed sentence when a conversation needs an answer', () => {
		const t = setup()
		t.notices.needsYou(['a'])
		expect(t.shown).toHaveLength(0)
		t.advance(FOLD_MS)
		expect(t.shown.map((item) => item.payload)).toEqual([
			{ title: 'Alpha', body: 'A conversation needs your answer', silent: true },
		])
	})

	it('notifies a turn that ran past the threshold and stays quiet for one you watched end', () => {
		const t = setup()
		t.notices.turnStarted('a')
		t.advance(LONG)
		t.notices.turnEnded('a', 'finished', false)
		t.advance(FOLD_MS)
		expect(t.shown.map((item) => item.payload)).toEqual([
			{ title: 'Alpha', body: 'Finished', silent: true },
		])
		t.notices.turnStarted('b')
		t.advance(FINISHED_NOTICE_AFTER_MS - 1)
		t.notices.turnEnded('b', 'finished', false)
		t.advance(FOLD_MS)
		expect(t.shown).toHaveLength(1)
	})

	it('notifies a turn that ran exactly the threshold, and not one a millisecond short of it', () => {
		const t = setup()
		t.notices.turnStarted('a')
		t.advance(FINISHED_NOTICE_AFTER_MS)
		t.notices.turnEnded('a', 'finished', false)
		t.advance(FOLD_MS)
		expect(t.shown).toHaveLength(1)
	})

	it('folds for the time the host names, not the default', () => {
		const t = setup({}, undefined, 50)
		t.notices.needsYou(['a'])
		t.advance(49)
		expect(t.shown).toHaveLength(0)
		t.advance(1)
		expect(t.shown).toHaveLength(1)
	})

	it('drops a second event of the same kind for a conversation until a window is focused', () => {
		const t = setup()
		t.notices.turnStarted('a')
		t.notices.turnEnded('a', 'failed', false)
		t.advance(FOLD_MS)
		t.notices.turnStarted('a')
		t.notices.turnEnded('a', 'failed', false)
		t.advance(FOLD_MS)
		expect(t.shown).toHaveLength(1)
		t.focus(true)
		t.focus(false)
		t.notices.turnStarted('a')
		t.notices.turnEnded('a', 'failed', false)
		t.advance(FOLD_MS)
		expect(t.shown).toHaveLength(2)
	})

	it('reads the threshold from the host when it names one', () => {
		const t = setup({}, 5000)
		t.notices.turnStarted('a')
		t.advance(5000)
		t.notices.turnEnded('a', 'finished', false)
		t.advance(FOLD_MS)
		expect(t.shown).toHaveLength(1)
	})

	it('notifies a failed turn at any length', () => {
		const t = setup()
		t.notices.turnStarted('a')
		t.notices.turnEnded('a', 'failed', false)
		t.advance(FOLD_MS)
		expect(t.shown.map((item) => item.payload.body)).toEqual(['Stopped with an error'])
	})

	it('ignores a stop the person asked for and a turn it never saw start', () => {
		const t = setup()
		t.notices.turnStarted('a')
		t.advance(LONG)
		t.notices.turnEnded('a', 'other', false)
		t.notices.turnEnded('b', 'finished', false)
		t.advance(FOLD_MS)
		expect(t.shown).toHaveLength(0)
	})

	it('folds events that arrive together into one notification per kind', () => {
		const t = setup()
		for (const id of ['a', 'b', 'c']) t.notices.turnStarted(id)
		t.advance(LONG)
		t.notices.turnEnded('a', 'finished', false)
		t.advance(1000)
		t.notices.turnEnded('b', 'finished', false)
		t.notices.turnEnded('c', 'finished', false)
		t.advance(FOLD_MS)
		expect(t.shown.map((item) => item.payload)).toEqual([
			{ title: 'Namzu', body: '3 conversations finished', silent: true },
		])
		t.shown[0]?.click()
		expect(t.opened).toEqual(['a'])
	})

	it('folds each kind on its own', () => {
		const t = setup()
		t.notices.turnStarted('a')
		t.notices.turnEnded('a', 'failed', false)
		t.notices.needsYou(['b'])
		t.advance(FOLD_MS)
		expect(t.shown.map((item) => item.payload.body).sort()).toEqual(
			[NOTICE_SENTENCES.failed, NOTICE_SENTENCES['needs-you']].sort(),
		)
	})

	it('shows a conversation at most once per kind until the person comes back', () => {
		const t = setup()
		t.notices.turnStarted('a')
		t.notices.turnEnded('a', 'failed', false)
		t.advance(FOLD_MS)
		t.notices.turnStarted('a')
		t.notices.turnEnded('a', 'failed', false)
		t.advance(FOLD_MS)
		expect(t.shown).toHaveLength(1)
		t.focus(true)
		expect(t.shown[0]?.closed).toBe(true)
		t.focus(false)
		t.notices.turnStarted('a')
		t.notices.turnEnded('a', 'failed', false)
		t.advance(FOLD_MS)
		expect(t.shown).toHaveLength(2)
	})

	it('shows nothing while a window is focused, and drops events when the person returns first', () => {
		const t = setup()
		t.focus(true)
		t.notices.needsYou(['a'])
		t.notices.turnStarted('b')
		t.notices.turnEnded('b', 'failed', false)
		t.advance(FOLD_MS)
		expect(t.shown).toHaveLength(0)
		t.focus(false)
		t.notices.turnStarted('c')
		t.notices.turnEnded('c', 'failed', false)
		t.focus(true)
		t.advance(FOLD_MS)
		expect(t.shown).toHaveLength(0)
	})

	it('does not announce a conversation that was already waiting when the window lost focus', () => {
		const t = setup()
		t.focus(true)
		t.notices.needsYou(['a'])
		t.focus(false)
		t.notices.needsYou(['a'])
		t.advance(FOLD_MS)
		expect(t.shown).toHaveLength(0)
	})

	it('treats a Pal as needs-you only', () => {
		const t = setup()
		t.notices.turnStarted('a')
		t.advance(LONG)
		t.notices.turnEnded('a', 'finished', true)
		t.notices.turnStarted('b')
		t.notices.turnEnded('b', 'failed', true)
		t.advance(FOLD_MS)
		expect(t.shown).toHaveLength(0)
		t.notices.needsYou(['c'])
		t.advance(FOLD_MS)
		expect(t.shown.map((item) => item.payload.body)).toEqual([NOTICE_SENTENCES['needs-you']])
	})

	it('follows each switch, read on every event', () => {
		const t = setup({ needsYou: false, failed: false, finished: false })
		t.notices.needsYou(['a'])
		t.notices.turnStarted('b')
		t.advance(LONG)
		t.notices.turnEnded('b', 'finished', false)
		t.notices.turnStarted('c')
		t.notices.turnEnded('c', 'failed', false)
		t.advance(FOLD_MS)
		expect(t.shown).toHaveLength(0)
		t.settings.finished = true
		t.notices.turnStarted('b')
		t.advance(LONG)
		t.notices.turnEnded('b', 'finished', false)
		t.advance(FOLD_MS)
		expect(t.shown.map((item) => item.payload.body)).toEqual(['Finished'])
	})

	it('makes a sound only when the sound switch is on', () => {
		const t = setup({ sound: true })
		t.notices.needsYou(['a'])
		t.advance(FOLD_MS)
		expect(t.shown[0]?.payload.silent).toBe(false)
	})

	it('does nothing where the system cannot show notifications', () => {
		const t = setup()
		t.support(false)
		t.notices.needsYou(['a'])
		t.advance(FOLD_MS)
		expect(t.shown).toHaveLength(0)
	})

	it('opens the conversation of a single notification when it is clicked', () => {
		const t = setup()
		t.notices.needsYou(['b'])
		t.advance(FOLD_MS)
		t.shown[0]?.click()
		expect(t.opened).toEqual(['b'])
	})

	it('puts only the project name and a fixed sentence in any payload', () => {
		const t = setup()
		t.notices.needsYou(['a'])
		t.notices.turnStarted('b')
		t.advance(LONG)
		t.notices.turnEnded('b', 'finished', false)
		t.notices.turnStarted('c')
		t.notices.turnEnded('c', 'failed', false)
		t.advance(FOLD_MS)
		const sentences: string[] = Object.values(NOTICE_SENTENCES)
		expect(t.shown).toHaveLength(3)
		for (const { payload } of t.shown) {
			expect(Object.keys(payload).sort()).toEqual(['body', 'silent', 'title'])
			expect(sentences).toContain(payload.body)
			expect(['Alpha', 'Beta', 'Gamma']).toContain(payload.title)
		}
	})
})
