import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	AwayRecap,
	type AwayRecapDeps,
	RECAP_BLUR_DEBOUNCE_MS,
	RECAP_MAX_FAILURES,
	RECAP_SUFFIX,
	RECAP_SUFFIX_COUNT,
	RECAP_WAIT_MS,
	type RecapRowKind,
} from './away-recap.js'
import { createTerminalFocus } from './terminal-focus.js'

const CONVERSATION: readonly RecapRowKind[] = [
	'prompt',
	'reply',
	'prompt',
	'reply',
	'prompt',
	'reply',
]

interface Rig {
	readonly recap: AwayRecap
	readonly focus: ReturnType<typeof createTerminalFocus>
	readonly appended: string[]
	readonly generate: ReturnType<typeof vi.fn>
	readonly state: {
		enabled: boolean
		turnRunning: boolean
		draft: boolean
		background: boolean
		loop: boolean
		rows: readonly RecapRowKind[]
	}
}

function rig(
	overrides: Partial<AwayRecapDeps> = {},
	text: string | null = 'Doing the thing.',
): Rig {
	const focus = createTerminalFocus()
	const appended: string[] = []
	const state = {
		enabled: true,
		turnRunning: false,
		draft: false,
		background: false,
		loop: false,
		rows: CONVERSATION,
	}
	const generate = vi.fn(async (_signal: AbortSignal) => text ?? undefined)
	const recap = new AwayRecap({
		now: () => Date.now(),
		setTimer: (run, ms) => setTimeout(run, ms),
		clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		focus,
		enabled: () => state.enabled,
		isTurnRunning: () => state.turnRunning,
		draftPresent: () => state.draft,
		backgroundWorkPending: () => state.background,
		loopScheduled: () => state.loop,
		rows: () => state.rows,
		generate,
		append: (line) => appended.push(line),
		...overrides,
	})
	return { recap, focus, appended, generate, state }
}

/** Let the generate promise and its continuation settle. */
async function settle(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0)
}

describe('the away recap', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it('writes a recap three minutes after the turn when the terminal is blurred', async () => {
		const { recap, focus, appended, generate } = rig()
		recap.turnSettled()
		focus.set(false)
		await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS - 1)
		expect(generate).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(generate).toHaveBeenCalledTimes(1)
		expect(appended).toEqual([`Doing the thing.${RECAP_SUFFIX}`])
	})

	it('waits two seconds after a late blur', async () => {
		const { recap, focus, generate } = rig()
		recap.turnSettled()
		await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS + 60_000)
		focus.set(false)
		await vi.advanceTimersByTimeAsync(RECAP_BLUR_DEBOUNCE_MS - 1)
		expect(generate).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(generate).toHaveBeenCalledTimes(1)
	})

	it('never starts when focus is unknown or focused', async () => {
		const { recap, focus, generate } = rig()
		recap.turnSettled()
		await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS * 2)
		expect(generate).not.toHaveBeenCalled()
		focus.set(true)
		await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS * 2)
		expect(generate).not.toHaveBeenCalled()
	})

	it('is cancelled by coming back, and a recap in flight is dropped', async () => {
		let release: (text: string) => void = () => undefined
		const pending = new Promise<string | undefined>((resolve) => {
			release = resolve
		})
		const { recap, focus, appended, generate } = rig({ generate: () => pending })
		recap.turnSettled()
		focus.set(false)
		await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS)
		focus.set(true)
		release('late')
		await settle()
		expect(appended).toEqual([])
		expect(generate).not.toHaveBeenCalled()
	})

	it('cancels the countdown when focus returns before it ends', async () => {
		const { recap, focus, generate } = rig()
		recap.turnSettled()
		focus.set(false)
		await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS - 1000)
		focus.set(true)
		await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS)
		expect(generate).not.toHaveBeenCalled()
	})

	it('is cancelled by a turn starting', async () => {
		const { recap, focus, generate } = rig()
		recap.turnSettled()
		focus.set(false)
		await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS - 1000)
		recap.turnStarted()
		await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS)
		expect(generate).not.toHaveBeenCalled()
	})

	it.each([
		[
			'switched off',
			(s: Rig['state']) => {
				s.enabled = false
			},
		],
		[
			'a draft in the composer',
			(s: Rig['state']) => {
				s.draft = true
			},
		],
		[
			'background work running',
			(s: Rig['state']) => {
				s.background = true
			},
		],
		[
			'a scheduled loop',
			(s: Rig['state']) => {
				s.loop = true
			},
		],
		[
			'fewer than three typed prompts',
			(s: Rig['state']) => {
				s.rows = ['prompt', 'reply', 'prompt', 'reply']
			},
		],
		[
			'a recap as the last row',
			(s: Rig['state']) => {
				s.rows = [...CONVERSATION, 'recap']
			},
		],
		[
			'fewer than two prompts since the last recap',
			(s: Rig['state']) => {
				s.rows = [...CONVERSATION, 'recap', 'prompt', 'reply']
			},
		],
	])('does not write when %s', async (_name, arrange) => {
		const { recap, focus, generate, state } = rig()
		arrange(state)
		recap.turnSettled()
		focus.set(false)
		await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS * 2)
		expect(generate).not.toHaveBeenCalled()
	})

	it('writes again once two more prompts have followed the last recap', async () => {
		const { recap, focus, generate, state } = rig()
		state.rows = [...CONVERSATION, 'recap', 'prompt', 'reply', 'prompt', 'reply']
		recap.turnSettled()
		focus.set(false)
		await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS)
		expect(generate).toHaveBeenCalledTimes(1)
	})

	it('does not write while a turn is running', async () => {
		const { recap, focus, generate, state } = rig()
		recap.turnSettled()
		state.turnRunning = true
		focus.set(false)
		await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS * 2)
		expect(generate).not.toHaveBeenCalled()
	})

	it('gives up on a turn after three failures', async () => {
		const { recap, focus, generate } = rig({}, null)
		for (let attempt = 0; attempt < RECAP_MAX_FAILURES + 2; attempt += 1) {
			recap.turnSettled()
			// A blur that began and ended around each settle re-arms the countdown;
			// within one turn only refreshes count.
			focus.set(true)
			focus.set(false)
			await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS)
		}
		// Each settle starts a new turn with its own allowance, so every attempt ran once.
		expect(generate).toHaveBeenCalledTimes(RECAP_MAX_FAILURES + 2)

		const within = rig({}, null)
		within.recap.turnSettled()
		for (let attempt = 0; attempt < RECAP_MAX_FAILURES + 2; attempt += 1) {
			within.focus.set(true)
			within.focus.set(false)
			await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS)
		}
		expect(within.generate).toHaveBeenCalledTimes(RECAP_MAX_FAILURES)
	})

	it('puts the hint on the first three recaps only, counted per instance', async () => {
		const { recap, focus, appended, state } = rig()
		for (let n = 0; n < RECAP_SUFFIX_COUNT + 1; n += 1) {
			state.rows = CONVERSATION
			recap.turnSettled()
			focus.set(true)
			focus.set(false)
			await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS)
		}
		expect(appended.map((line) => line.endsWith(RECAP_SUFFIX))).toEqual([true, true, true, false])

		const fresh = rig()
		fresh.recap.turnSettled()
		fresh.focus.set(false)
		await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS)
		expect(fresh.appended[0]?.endsWith(RECAP_SUFFIX)).toBe(true)
	})

	it('forgets the old conversation on reset and when disposed', async () => {
		const first = rig()
		first.recap.turnSettled()
		first.focus.set(false)
		first.recap.reset()
		await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS * 2)
		expect(first.generate).not.toHaveBeenCalled()

		const second = rig()
		second.recap.turnSettled()
		second.focus.set(false)
		second.recap.dispose()
		await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS * 2)
		expect(second.generate).not.toHaveBeenCalled()
	})

	it('starts counting when it is switched on after the turn ended', async () => {
		const { recap, focus, generate, state } = rig()
		state.enabled = false
		recap.turnSettled()
		focus.set(false)
		state.enabled = true
		recap.refresh()
		await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS)
		expect(generate).toHaveBeenCalledTimes(1)
	})
})
