import { describe, expect, it } from 'vitest'

import { SPINNER_TIPS, type Tip, type TipContext, pickTip } from './spinner-tips.js'
import { EMPTY_TIP_HISTORY, type TipHistory } from './tip-history.js'

const ctx = (over: Partial<TipContext> = {}): TipContext => ({
	launch: 10,
	used: () => 0,
	env: {},
	statusLineSet: false,
	notificationsSet: false,
	lastTurnToolCalls: 0,
	...over,
})

const tip = (id: string, over: Partial<Tip> = {}): Tip => ({
	id,
	text: id,
	cooldownLaunches: 5,
	relevant: () => true,
	...over,
})

const shown = (entries: Record<string, number>): TipHistory => ({
	...EMPTY_TIP_HISTORY,
	launches: 10,
	shown: Object.fromEntries(
		Object.entries(entries).map(([id, lastLaunch]) => [id, { lastLaunch, total: 1 }]),
	),
})

describe('pickTip', () => {
	it('returns nothing when no tip qualifies', () => {
		expect(pickTip([], ctx(), EMPTY_TIP_HISTORY)).toBeUndefined()
		expect(pickTip([tip('a', { relevant: () => false })], ctx(), EMPTY_TIP_HISTORY)).toBeUndefined()
	})

	it('holds a tip back until its cooldown in launches has passed, to the launch', () => {
		const tips = [tip('a')]
		expect(pickTip(tips, ctx({ launch: 10 }), shown({ a: 6 }))).toBeUndefined()
		expect(pickTip(tips, ctx({ launch: 10 }), shown({ a: 5 }))?.id).toBe('a')
		// shown this very launch: cannot return until the cooldown has passed
		expect(pickTip(tips, ctx({ launch: 10 }), shown({ a: 10 }))).toBeUndefined()
	})

	it('prefers a never-shown tip, then the one not shown for longest', () => {
		const tips = [tip('a'), tip('b'), tip('c')]
		expect(pickTip(tips, ctx(), shown({ a: 1, b: 3 }))?.id).toBe('c')
		expect(pickTip(tips, ctx(), shown({ a: 3, b: 1, c: 2 }))?.id).toBe('b')
	})

	it('breaks a tie on priority, then on registry order', () => {
		expect(pickTip([tip('a'), tip('b', { priority: 2 })], ctx(), EMPTY_TIP_HISTORY)?.id).toBe('b')
		expect(pickTip([tip('a'), tip('b')], ctx(), EMPTY_TIP_HISTORY)?.id).toBe('a')
	})

	it('stops offering a tip after its lifetime cap', () => {
		const history: TipHistory = {
			...EMPTY_TIP_HISTORY,
			shown: { a: { lastLaunch: 1, total: 3 } },
		}
		expect(pickTip([tip('a', { maxLifetimeShows: 3 })], ctx(), history)).toBeUndefined()
		expect(pickTip([tip('a', { maxLifetimeShows: 4 })], ctx(), history)?.id).toBe('a')
	})

	it('skips a tip whose condition throws and does not ask it again in the process', () => {
		let asked = 0
		const broken = tip('broken', {
			relevant: () => {
				asked += 1
				throw new Error('nope')
			},
		})
		const failed = new Set<string>()
		expect(pickTip([broken, tip('ok')], ctx(), EMPTY_TIP_HISTORY, failed)?.id).toBe('ok')
		expect(pickTip([broken, tip('ok')], ctx(), EMPTY_TIP_HISTORY, failed)?.id).toBe('ok')
		expect(asked).toBe(1)
	})
})

describe('the terminal tips', () => {
	const ids = (over: Partial<TipContext>): string[] =>
		SPINNER_TIPS.filter((tip) => tip.relevant(ctx({ platform: 'linux', launch: 6, ...over }))).map(
			(tip) => tip.id,
		)

	it('suggests /terminal-setup only where it can set something up, and stops once it has', () => {
		expect(ids({ env: { TERM_PROGRAM: 'vscode' } })).toContain('shift-enter-setup')
		expect(ids({ env: { TERM_PROGRAM: 'ghostty' } })).not.toContain('shift-enter-setup')
		expect(ids({ env: { TERM_PROGRAM: 'vscode' }, newlineKeyInstalled: true })).not.toContain(
			'shift-enter-setup',
		)
		expect(ids({ env: { TERM_PROGRAM: 'vscode' }, newlineKeyInstalled: true })).toContain(
			'shift-enter-reminder',
		)
	})

	it('says Option+Enter in Terminal.app', () => {
		expect(ids({ env: { TERM_PROGRAM: 'Apple_Terminal' }, platform: 'darwin' })).toContain(
			'option-enter-setup',
		)
	})

	it('offers the way back to fullscreen after a failed start', () => {
		expect(ids({ fullscreenAutoOff: true })).toContain('fullscreen-off-here')
		expect(ids({})).not.toContain('fullscreen-off-here')
	})
})
