/**
 * The launch half of the background Zen catalogue refresh: `runCli` starts it,
 * does NOT wait for it before the TUI is up, and cancels it when the command
 * returns. The refresh's own behaviour is `zen-catalogue.test.ts`; this owns
 * the otherwise-unobserved hop from a launch to that refresh.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ZenCatalogueResult } from '@namzu/zen/catalogue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiContext } from '../tui/types.js'

/**
 * Every refresh the launch started, and whether it has settled. `fetchBegan`
 * resolves when a refresh reaches its network call, which happens only after
 * its read of the last-good copy on disk; the tests wait for that event
 * rather than guess how long the read takes.
 */
const state = vi.hoisted(() => {
	const state = {
		refreshes: [] as { done: Promise<{ readonly kind: string }>; settled: boolean }[],
		fetchBegan: Promise.resolve(),
		noteFetchBegan: (): void => {},
		reset(): void {
			state.refreshes.length = 0
			state.fetchBegan = new Promise<void>((resolve) => {
				state.noteFetchBegan = resolve
			})
		},
	}
	state.reset()
	return state
})

/** An unreachable network: the derivation settles only when its signal aborts. */
vi.mock('../integrations/providers/zen-catalogue.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../integrations/providers/zen-catalogue.js')>()
	return {
		...actual,
		startZenCatalogueRefresh: (options: Parameters<typeof actual.startZenCatalogueRefresh>[0]) => {
			const handle = actual.startZenCatalogueRefresh({
				...options,
				fetchCatalogue: ({ signal }) => {
					state.noteFetchBegan()
					return new Promise<ZenCatalogueResult>((_resolve, reject) => {
						// A launch that ended during the disk read hands over a signal
						// that is already aborted; that never fires the event.
						if (signal.aborted) reject(signal.reason)
						else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
					})
				},
			})
			const entry = { done: handle.done, settled: false }
			void handle.done.then(() => {
				entry.settled = true
			})
			state.refreshes.push(entry)
			return handle
		},
	}
})

/** What the launch had done about the refresh at the moment the TUI took over. */
const atLaunch = vi.hoisted(() => ({ started: 0, settled: 0 }))
const launchTui = vi.hoisted(() =>
	vi.fn(async (_ctx: TuiContext) => {
		// The TUI is up. Let the refresh get as far as its network call, as it
		// would while Ink renders, so "still outstanding" is read with the
		// request in flight.
		if (state.refreshes.length > 0) await state.fetchBegan
		atLaunch.started = state.refreshes.length
		atLaunch.settled = state.refreshes.filter((entry) => entry.settled).length
	}),
)
vi.mock('../tui/index.js', () => ({ launchTui }))

const { opensSessions, runCli } = await import('../cli.js')

describe('the launch starts a background Zen catalogue refresh', () => {
	const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
	const originalRefresh = process.env.NAMZU_MODEL_CATALOGUE_REFRESH

	beforeEach(() => {
		state.reset()
		atLaunch.started = 0
		atLaunch.settled = 0
		vi.spyOn(process, 'cwd').mockReturnValue(mkdtempSync(join(tmpdir(), 'namzu-zen-launch-')))
		Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
	})

	afterEach(() => {
		launchTui.mockClear()
		vi.restoreAllMocks()
		if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
		else Reflect.deleteProperty(process.stdout, 'isTTY')
		if (originalRefresh === undefined)
			Reflect.deleteProperty(process.env, 'NAMZU_MODEL_CATALOGUE_REFRESH')
		else process.env.NAMZU_MODEL_CATALOGUE_REFRESH = originalRefresh
	})

	it('reaches the TUI while the refresh is still outstanding, and cancels it on return', async () => {
		Reflect.deleteProperty(process.env, 'NAMZU_MODEL_CATALOGUE_REFRESH')

		// The network never answers. A launch that awaited the refresh would
		// hang here until the 30-second budget, far past the test timeout.
		await expect(runCli({ argv: ['node', 'namzu'] })).resolves.toBe(0)

		expect(launchTui).toHaveBeenCalledOnce()
		expect(atLaunch).toEqual({ started: 1, settled: 0 })
		// The command returned, so the refresh was cancelled rather than left
		// holding the process open.
		expect(state.refreshes).toHaveLength(1)
		await expect(state.refreshes[0]?.done).resolves.toEqual({ kind: 'cancelled' })
	})

	// `drain` opens agent sessions too: a turn parked on a
	// model only the live or last-good catalogue carries is continued there.
	it.each([['drain', ['drain']]])(
		'starts one for `namzu %s`, and cancels it on return',
		async (_label, args) => {
			Reflect.deleteProperty(process.env, 'NAMZU_MODEL_CATALOGUE_REFRESH')
			const originalHome = process.env.NAMZU_HOME
			process.env.NAMZU_HOME = mkdtempSync(join(tmpdir(), 'namzu-zen-launch-home-'))
			try {
				// Whatever the command itself makes of an empty home, the launch
				// returns while the refresh is still outstanding — it never waits on it.
				await runCli({ argv: ['node', 'namzu', ...args] })
			} finally {
				if (originalHome === undefined) Reflect.deleteProperty(process.env, 'NAMZU_HOME')
				else process.env.NAMZU_HOME = originalHome
			}
			expect(launchTui).not.toHaveBeenCalled()
			// One refresh, and it ends as cancelled whether the command returned
			// before or after the refresh reached the network.
			expect(state.refreshes).toHaveLength(1)
			await expect(state.refreshes[0]?.done).resolves.toEqual({ kind: 'cancelled' })
		},
	)

	it('names exactly the commands that open sessions', () => {
		for (const name of ['exec', 'acp', 'drain']) {
			expect(opensSessions(name)).toBe(true)
		}
		for (const removed of ['run', 'run-stream']) expect(opensSessions(removed)).toBe(false)
		for (const name of ['doctor', 'config', 'login', 'eval']) {
			expect(opensSessions(name)).toBe(false)
		}
	})

	it('starts nothing when the operator turned it off', async () => {
		process.env.NAMZU_MODEL_CATALOGUE_REFRESH = '0'
		await expect(runCli({ argv: ['node', 'namzu'] })).resolves.toBe(0)
		expect(launchTui).toHaveBeenCalledOnce()
		expect(state.refreshes).toHaveLength(0)
	})
})
