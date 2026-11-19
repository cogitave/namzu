import { describe, expect, it } from 'vitest'
import type { ExtensionRow } from '../shared/extensions-view.js'
import {
	PAGE_STOPPED_WORDS,
	auditWords,
	backgroundLines,
	chipTone,
	clockWords,
	countLines,
	dayRange,
	daySummary,
	durationWords,
	failureWords,
	keptWords,
	languageName,
	licenceLines,
	mainAction,
	neverLine,
	noticeBlocks,
	offersNoticeLink,
	offersSecondaryNotice,
	pageEntries,
	plainReason,
	plainReasons,
	publisherLine,
	reachedEnd,
	readDayRows,
	ribbonLayout,
	rowsTable,
	stateKindOf,
	stateWord,
	stripWords,
} from './extensions-model.js'

const row = (over: Partial<ExtensionRow>): ExtensionRow => ({
	id: 'a.b.c',
	name: 'A',
	version: '1.0.0',
	publisher: 'P',
	state: 'ready',
	chip: 'Ready',
	dev: false,
	needs: [],
	enabled: false,
	licenceKind: 'key',
	languages: ['en'],
	shownLocale: 'en',
	running: false,
	grants: [],
	...over,
})

describe('neverLine', () => {
	it('separates the items instead of running them together', () => {
		expect(
			neverLine([
				'Which keys were pressed',
				'Screenshots or any image, stored or sent',
				'Window titles.',
			]),
		).toBe('Which keys were pressed; screenshots or any image, stored or sent; window titles.')
	})
	it('keeps an acronym and says nothing for no items', () => {
		expect(neverLine(['Keys', 'URL paths'])).toBe('Keys; URL paths.')
		expect(neverLine([])).toBe('')
	})
})

describe('what a card offers', () => {
	it('offers the one action that fits each state', () => {
		expect(mainAction(row({ state: 'added', needs: ['license', 'notice'] })).kind).toBe('license')
		expect(mainAction(row({ state: 'added', needs: ['notice'] })).kind).toBe('enable')
		expect(mainAction(row({ state: 'needs-notice', needs: ['notice'] })).kind).toBe('notice')
		expect(mainAction(row({ state: 'ready' })).kind).toBe('enable')
		expect(mainAction(row({ state: 'running', enabled: true })).kind).toBe('disable')
		expect(mainAction(row({ state: 'failed' })).kind).toBe('start-again')
		expect(mainAction(row({ state: 'license-expired' })).kind).toBe('license')
		expect(
			mainAction(row({ state: 'running', updateWaiting: { version: '2.0.0', reasons: ['x'] } }))
				.kind,
		).toBe('review-update')
	})
	it('never offers a way to run it while the update waits for a failed one', () => {
		expect(
			mainAction(row({ state: 'failed', updateWaiting: { version: '2.0.0', reasons: [] } })).kind,
		).toBe('start-again')
	})
	it('does not repeat "Read the notice" beside a main button that already says it', () => {
		expect(
			offersSecondaryNotice(mainAction(row({ state: 'needs-notice', needs: ['notice'] }))),
		).toBe(false)
		expect(offersSecondaryNotice(mainAction(row({ state: 'running', enabled: true })))).toBe(true)
	})
	it('tones the chip by state', () => {
		expect(chipTone('running', false)).toBe('good')
		expect(chipTone('running', true)).toBe('warn')
		expect(chipTone('failed', false)).toBe('bad')
		expect(chipTone('ready', false)).toBe('quiet')
	})
})

describe('plain words for a refusal', () => {
	it('says what each check means', () => {
		expect(
			failureWords({
				code: 'untrusted-publisher',
				check: 'trusted-key',
				message: 'This file was not signed by a publisher Namzu trusts (key x).',
			}),
		).toBe('This file was not signed by a publisher Namzu trusts.')
		expect(
			failureWords({
				code: 'untrusted-publisher',
				check: 'trusted-key',
				message: 'No trusted publisher keys in this build, so no package can be added.',
			}),
		).toMatch(/does not trust any extension publisher yet/)
		expect(failureWords({ code: 'tampered', check: 'file-hash', message: 'x' })).toMatch(
			/changed after it was signed/,
		)
		expect(
			failureWords({
				code: 'engine',
				check: 'engines',
				message: 'This extension needs Namzu >=53.5.0 <54; this is 53.4.1.',
			}),
		).toMatch(/needs Namzu >=53\.5\.0/)
		expect(failureWords({ code: 'weird', check: '', message: 'the engine’s own words' })).toBe(
			'the engine’s own words',
		)
		expect(failureWords({ code: 'weird', check: '', message: '' })).toBe('Something went wrong.')
	})
})

describe('the notice screen', () => {
	it('shows Markdown as headings, items and paragraphs, with comments and emphasis removed', () => {
		const blocks = noticeBlocks(
			'<!-- locale: en -->\n# Title\n\nFirst line\nsecond line **bold**.\n\n- one\n- two with `code`\n',
		)
		expect(blocks.map((b) => [b.kind, b.text])).toEqual([
			['h', 'Title'],
			['p', 'First line second line bold.'],
			['li', 'one'],
			['li', 'two with `code`'],
		])
		expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length)
	})
	it('counts a text that needs no scrolling as read, and the end of a long one', () => {
		expect(reachedEnd(0, 400, 400)).toBe(true)
		expect(reachedEnd(0, 400, 1200)).toBe(false)
		expect(reachedEnd(797, 400, 1200)).toBe(true)
	})
})

describe('what is collected', () => {
	it('words the retention', () => {
		expect(keptWords(1)).toBe('Kept 1 day.')
		expect(keptWords(7)).toBe('Kept 7 days.')
		expect(keptWords('keep')).toBe('Kept until your organisation deletes it.')
	})
	it('turns any counts answer into plain lines, with no markup', () => {
		expect(
			countLines({
				counts: [
					{ kind: 'a.b', rows: 12, newest: '12:03' },
					{ kind: 'c.d', rows: 0 },
				],
			}),
		).toEqual(['a.b: rows 12: newest 12:03', 'c.d: rows 0'])
		expect(countLines({ kind: 'a.b', count: 3 })).toEqual(['a.b: count 3'])
		expect(countLines('nope')).toEqual([])
	})
	it('words the per-kind counts of the activity extension without ids, dates or field names', () => {
		const answer = {
			asOf: '2026-11-18T21:54:00Z',
			day: '2026-11-18',
			kinds: [
				{
					id: 'activity.app.minute',
					rows: 834,
					first: '2026-11-18T07:00:00Z',
					last: '2026-11-18T21:53:00Z',
				},
				{ id: 'activity.session.event', rows: 1 },
				{ id: 'activity.screen.minute', rows: 0 },
			],
		}
		const describe = (id: string) =>
			id === 'activity.app.minute' ? 'Seconds per application in each minute.' : undefined
		const lines = countLines(answer, describe)
		expect(lines).toEqual([
			'Seconds per application in each minute: 834 records',
			'activity.session.event: 1 record',
			'activity.screen.minute: nothing yet',
		])
		expect(lines.join(' ')).not.toMatch(/asOf|retentionDays|2026-11/)
	})
	it('reads a rows answer into a table, clipping and ignoring what is not text or numbers', () => {
		const t = rowsTable({
			kind: 'a.b',
			columns: ['minute', 'exe'],
			rows: [['2026-01-01T00:00:00Z', 'a.exe', 'extra'], [null, 5], 'bad'],
		})
		expect(t?.columns).toEqual(['minute', 'exe'])
		expect(t?.rows).toEqual([['2026-01-01T00:00:00Z', 'a.exe'], ['', '5'], []])
		expect(rowsTable({ kind: 'a.b' })).toBeUndefined()
	})
})

describe('the licence block says only facts', () => {
	it('kind none has nothing to say', () => {
		expect(licenceLines(row({ licenceKind: 'none' }))).toEqual([])
	})
	it('a service shows who it is checked with, when, and the offline days left', () => {
		const lines = licenceLines(
			row({
				licenceKind: 'service',
				licenceHost: 'license.example.com',
				licence: { customer: 'Example Customer', seats: 25, expires: '2027-06-01T00:00:00Z' },
				licenceChecked: { lastAt: Date.parse('2026-11-18T10:00:00Z') },
				licenceGraceDaysLeft: 1,
			}),
		)
		expect(lines[0]).toMatch(/Example Customer, 25 seats, valid until/)
		expect(lines).toContain('Checked with license.example.com')
		expect(lines.some((l) => l.startsWith('Last checked'))).toBe(true)
		expect(lines.at(-1)).toBe('The licence could not be checked. It keeps working for 1 more day.')
	})
	it('a withdrawn licence says so and offers the licence screen', () => {
		const r = row({ state: 'license-revoked', licenceKind: 'service' })
		expect(licenceLines(r)).toContain('The publisher withdrew this licence.')
		expect(mainAction(r).kind).toBe('license')
		expect(chipTone('license-revoked', false)).toBe('bad')
		expect(chipTone('license-grace', false)).toBe('warn')
	})
})

describe('start at sign-in in plain words', () => {
	const bg = {
		indicator: 'tray' as const,
		indicatorLabel: 'Recording is running.',
		defaultOn: true,
		enabled: true,
		hostedBy: 'runner' as const,
	}
	it('says it keeps running when Namzu is closed and what mark it shows', () => {
		const b = backgroundLines(row({ background: bg }))
		expect(b?.switchLabel).toBe('Start when I sign in')
		expect(b?.lines).toEqual([
			'Running in the background. It keeps running when Namzu is closed.',
			'While Namzu is closed it shows: Recording is running.',
		])
	})
	it('says when it shows nothing, and when the computer switched the entry off', () => {
		const b = backgroundLines(
			row({
				background: {
					...bg,
					indicator: 'none',
					indicatorLabel: undefined,
					hostedBy: 'app',
					signin: { registered: true, disabledByOs: true },
				},
			}),
		)
		expect(b?.lines).toContain('Running while Namzu is open.')
		expect(b?.lines).toContain('It shows nothing of its own while Namzu is closed.')
		expect(b?.lines.some((l) => /switched off starting at sign-in/.test(l))).toBe(true)
	})
	it('has nothing for an extension that does not start at sign-in', () => {
		expect(backgroundLines(row({}))).toBeUndefined()
	})
	it('uses no technical word for the runner, the entry or the system', () => {
		const text = JSON.stringify(
			backgroundLines(
				row({ background: { ...bg, signin: { registered: false, reason: 'access denied' } } }),
			),
		)
		expect(text).not.toMatch(/daemon|runner|launcher|task scheduler|autostart|registry|process/i)
	})
})

describe("where an extension's pages go", () => {
	const ui = {
		icon: 'ui/icon.svg',
		accent: '#2F6F4F',
		pages: [
			{ id: 'today', title: "Today's record", slot: 'settings' as const, usesNetwork: false },
			{ id: 'rail', title: 'Record', slot: 'sidebar' as const, usesNetwork: false },
		],
		chips: [
			{
				id: 'recording',
				state: 'gap',
				label: 'Recording with a gap',
				tone: 'warn' as const,
				opens: 'today',
			},
		],
	}
	it('sorts pages by slot, only for an extension that is on', () => {
		const on = row({ id: 'a.b.c', enabled: true, state: 'running', ui })
		const off = row({ id: 'd.e.f', ui })
		expect(pageEntries([on, off], 'settings').map((p) => p.pageId)).toEqual(['today'])
		expect(
			pageEntries([on, off], 'sidebar').map((p) => `${p.extensionId}/${p.pageId}/${p.accent}`),
		).toEqual(['a.b.c/rail/#2F6F4F'])
		expect(pageEntries([on], 'panel')).toEqual([])
	})
	it('the strip says who drew the page and that Namzu never asks for a secret in it', () => {
		const w = stripWords('Cogitave')
		expect(w.drawnBy).toBe('Page drawn by Cogitave')
		expect(w.warning).toBe('Namzu never asks for a key or a password inside an extension page.')
		expect(PAGE_STOPPED_WORDS.strikes).toMatch(/stopped/)
	})
})

describe('the card does not say the same thing twice', () => {
	it('leaves out the quiet notice link when the main button is already "Read the notice"', () => {
		expect(offersNoticeLink(mainAction(row({ state: 'needs-notice', needs: ['notice'] })))).toBe(
			false,
		)
		expect(offersNoticeLink(mainAction(row({ state: 'running' })))).toBe(true)
	})
})

describe('plain words in the notice and the log', () => {
	it('keeps numbered notice items apart instead of running them into one paragraph', () => {
		const blocks = noticeBlocks('Intro line.\n1. **First:** one.\n2. Second: two.\ncontinued')
		expect(blocks.map((b) => b.text)).toEqual([
			'Intro line.',
			'1. First: one.',
			'2. Second: two. continued',
		])
	})

	it('says an update reason without ids', () => {
		const ctx = { dataKinds: [{ id: 'a.b.c', description: 'Seconds per application.' }] }
		expect(plainReason('notice version 1.0 -> 1.1')).toBe(
			'The notice was reworded (version 1.0 to 1.1).',
		)
		expect(plainReason('longer retention for a.b.c: 7 -> 14', ctx)).toBe(
			'Seconds per application is now kept 14 days instead of 7.',
		)
		expect(plainReason('longer retention for x.y.z: 7 -> 14', ctx)).not.toMatch(/x\.y\.z/)
		expect(plainReason('some other line')).toBe('some other line')
	})

	it('says an audit line in words and shows an unknown one as written', () => {
		expect(auditWords('host-start', 'desktop')).toBe('Namzu started it')
		expect(auditWords('license-set', 'test-company')).not.toMatch(/test-company|set/)
		expect(auditWords('brand-new', 'x')).toBe('brand-new x')
	})

	it('names a language in words', () => {
		expect(languageName('tr')).toBe('Turkish')
		expect(languageName('')).toBe('the default language')
	})

	it('says the same reason once', () => {
		expect(
			plainReasons([
				'longer retention for a: 7 -> 14',
				'longer retention for b: 7 -> 14',
				'notice version 1.0 -> 1.1',
			]),
		).toEqual([
			'Some data is now kept 14 days instead of 7.',
			'The notice was reworded (version 1.0 to 1.1).',
		])
	})
})

describe('the one state word of a row', () => {
	const chip = (label: string, tone: 'ok' | 'info' | 'warn' = 'ok') => ({
		icon: 'x',
		accent: '#000000',
		pages: [],
		chips: [{ id: 'c', state: 'collecting', label, tone }],
	})
	it("uses the extension's own word while it runs, and Namzu's words otherwise", () => {
		expect(stateWord(row({ state: 'running', ui: chip('Recording') }))).toEqual({
			text: 'Recording',
			tone: 'on',
		})
		expect(stateWord(row({ state: 'running' }))).toEqual({ text: 'On', tone: 'on' })
		expect(stateWord(row({ state: 'running', ui: chip('Recording', 'warn') })).tone).toBe('warn')
		expect(stateWord(row({ state: 'ready' }))).toEqual({ text: 'Off', tone: 'off' })
		expect(stateWord(row({ state: 'stopped' })).text).toBe('Off')
		expect(stateWord(row({ state: 'needs-notice' }))).toEqual({
			text: 'Needs your notice',
			tone: 'warn',
		})
		expect(stateWord(row({ state: 'failed' }))).toEqual({ text: 'Stopped', tone: 'bad' })
		expect(stateWord(row({ state: 'license-expired' })).text).toBe('Needs a licence')
	})
	it('a chip word is never shown for an extension that is not running', () => {
		expect(stateWord(row({ state: 'ready', ui: chip('Recording') })).text).toBe('Off')
	})
	it('an update that asks for more is said first', () => {
		expect(
			stateWord(row({ state: 'running', updateWaiting: { version: '2', reasons: [] } })).text,
		).toBe('Update to review')
	})
	it('words the line under the name', () => {
		expect(publisherLine(row({ publisher: 'Cogitave', version: '0.2.0' }))).toBe('Cogitave · 0.2.0')
	})
})

describe("today's record inside the extension's own screen", () => {
	const today = new Date(2026, 10, 19, 17, 42)
	const at = (h: number, m: number) => new Date(2026, 10, 19, h, m).toISOString()
	const columns = ['ts', 'activeS', 'idleS', 'lockedS', 'asleepS']
	it('words durations and clocks', () => {
		expect(durationWords(320)).toBe('5 h 20 min')
		expect(durationWords(28)).toBe('28 min')
		expect(durationWords(60)).toBe('1 h 00 min')
		expect(durationWords(-3)).toBe('0 min')
		expect(clockWords(527)).toBe('08:47')
	})
	it("finds the per-minute state kind by what it holds, not by one extension's name", () => {
		expect(
			stateKindOf({
				kinds: [
					{ id: 'activity.app.minute', rows: 3 },
					{ id: 'activity.state.minute', rows: 9 },
				],
			}),
		).toBe('activity.state.minute')
		expect(stateKindOf({ kinds: [{ id: 'x.y', rows: 1 }] })).toBeUndefined()
		expect(stateKindOf(null)).toBeUndefined()
	})
	it('adds the day up, merges neighbours and leaves yesterday out', () => {
		const answer = {
			kind: 'activity.state.minute',
			columns,
			rows: [
				[at(8, 55), 60, 0, 0, 0],
				[at(8, 56), 50, 10, 0, 0],
				[at(8, 57), 0, 60, 0, 0],
				[at(9, 30), 0, 0, 30, 30],
				[new Date(2026, 10, 18, 9, 0).toISOString(), 60, 0, 0, 0],
			],
		}
		const d = daySummary(answer, today)
		expect(d).toMatchObject({
			atMinutes: 2,
			idleMinutes: 1,
			awayMinutes: 1,
			firstMinute: 8 * 60 + 55,
			lastMinute: 9 * 60 + 31,
		})
		expect(d?.parts).toEqual([
			{ from: 535, to: 537, state: 'at' },
			{ from: 537, to: 538, state: 'idle' },
			{ from: 570, to: 571, state: 'away' },
		])
	})
	it('reads times given as seconds or milliseconds', () => {
		const t = new Date(2026, 10, 19, 10, 0).getTime()
		const sec = daySummary({ columns, rows: [[t / 1000, 60, 0, 0, 0]] }, today)
		const ms = daySummary({ columns, rows: [[t, 60, 0, 0, 0]] }, today)
		expect(sec?.firstMinute).toBe(600)
		expect(ms?.firstMinute).toBe(600)
	})
	it('gives totals without a ribbon when the rows carry no times, and nothing when it understands nothing', () => {
		const noTimes = daySummary({ columns: ['activeS', 'idleS'], rows: [[120, 60]] }, today)
		expect(noTimes).toMatchObject({ atMinutes: 2, idleMinutes: 1, parts: [] })
		expect(noTimes?.firstMinute).toBeUndefined()
		expect(daySummary({ columns: ['exe'], rows: [['a.exe']] }, today)).toBeUndefined()
		expect(daySummary('nope', today)).toBeUndefined()
		expect(daySummary({ columns, rows: 'x' }, today)).toBeUndefined()
	})
	it('lays the ribbon over whole hours, leaves gaps empty and marks now', () => {
		const r = ribbonLayout(
			[
				{ from: 8 * 60 + 47, to: 10 * 60, state: 'at' },
				{ from: 11 * 60, to: 12 * 60, state: 'idle' },
			],
			17 * 60 + 42 - 5 * 60,
		)
		expect(r?.segments.map((s) => s.state)).toEqual(['gap', 'at', 'gap', 'idle'])
		expect(r?.ticks.map((t) => t.label)).toEqual(['08:00', '10:00', '12:00', '14:00'])
		const total = r?.segments.reduce((n, s) => n + s.width, 0) ?? 0
		expect(total).toBeGreaterThan(0)
		expect(total).toBeLessThanOrEqual(100)
		expect(r?.now).toBeCloseTo(78.33, 1)
	})
	it('makes a short day at least six hours wide, and draws nothing for no parts', () => {
		const r = ribbonLayout([{ from: 600, to: 610, state: 'at' }], 605)
		expect(r?.ticks.length).toBeGreaterThan(1)
		expect(ribbonLayout([], 0)).toBeUndefined()
	})
})

describe('reading the whole of today, not the first rows the extension keeps', () => {
	const now = new Date(2026, 10, 19, 14, 30)
	const cols = ['ts', 'activeS', 'idleS', 'lockedS', 'asleepS']
	it('asks for local midnight to the next midnight as UTC text', () => {
		const r = dayRange(now)
		expect(r.from).toBe(new Date(2026, 10, 19).toISOString().replace('.000Z', 'Z'))
		expect(r.to).toBe(new Date(2026, 10, 20).toISOString().replace('.000Z', 'Z'))
		expect(r.from).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
	})
	it('follows next until it is null and joins the pages, with the bounds and the page size on every call', async () => {
		const seen: Record<string, unknown>[] = []
		const pages: Record<string, { rows: unknown[]; next: string | null }> = {
			first: { rows: [[1, 60, 0, 0, 0]], next: 'o1' },
			o1: { rows: [[2, 60, 0, 0, 0]], next: 'o2' },
			o2: { rows: [[3, 30, 0, 0, 0]], next: null },
		}
		const all = await readDayRows('activity.state.minute', now, async (p) => {
			seen.push(p)
			const a = pages[(p.after as string | undefined) ?? 'first']
			return { columns: cols, ...a }
		})
		expect(all?.rows).toHaveLength(3)
		expect(seen.map((p) => p.after)).toEqual([undefined, 'o1', 'o2'])
		for (const p of seen)
			expect(p).toMatchObject({ kind: 'activity.state.minute', limit: 500, ...dayRange(now) })
	})
	it('counts today from rows that come after earlier days in the first page', async () => {
		const early = Array.from({ length: 100 }, (_, i) => [
			new Date(2026, 10, 18, 8, i % 60).toISOString(),
			60,
			0,
			0,
			0,
		])
		const todays = [[new Date(2026, 10, 19, 9, 0).toISOString(), 120, 0, 0, 0]]
		// The extension honours the bounds: a page for today holds only today's rows.
		const all = await readDayRows('k', now, async (p) => ({
			columns: cols,
			rows: (p.from as string) <= new Date(2026, 10, 18, 9).toISOString() ? early : todays,
			next: null,
		}))
		expect(daySummary(all, now)).toMatchObject({ atMinutes: 2 })
	})
	it('says nothing when the first page cannot be read, and keeps what it has when a later one fails', async () => {
		expect(await readDayRows('k', now, async () => undefined)).toBeUndefined()
		let n = 0
		const part = await readDayRows('k', now, async () =>
			n++ === 0 ? { columns: cols, rows: [[1, 60, 0, 0, 0]], next: 'o1' } : undefined,
		)
		expect(part?.rows).toHaveLength(1)
	})
})
