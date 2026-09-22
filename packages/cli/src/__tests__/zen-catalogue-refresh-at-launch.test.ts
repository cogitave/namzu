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

/** Every derivation the launch started: its signal, and whether it has settled. */
const started = vi.hoisted(() => [] as { signal: AbortSignal; settled: boolean }[])

/** An unreachable network: the derivation settles only when its signal aborts. */
vi.mock('../integrations/providers/zen-catalogue.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../integrations/providers/zen-catalogue.js')>()
	return {
		...actual,
		startZenCatalogueRefresh: (options: Parameters<typeof actual.startZenCatalogueRefresh>[0]) =>
			actual.startZenCatalogueRefresh({
				...options,
				fetchCatalogue: ({ signal }) => {
					const entry = { signal, settled: false }
					started.push(entry)
					return new Promise<ZenCatalogueResult>((_resolve, reject) => {
						signal.addEventListener('abort', () => {
							entry.settled = true
							reject(signal.reason)
						})
					})
				},
			}),
	}
})

/** What the launch had done about the refresh at the moment the TUI took over. */
const atLaunch = vi.hoisted(() => ({ started: 0, settled: 0 }))
const launchTui = vi.hoisted(() =>
	vi.fn(async (_ctx: TuiContext) => {
		// Let the refresh's first microtasks run, as they would while Ink renders.
		await new Promise((resolve) => setTimeout(resolve, 10))
		atLaunch.started = started.length
		atLaunch.settled = started.filter((entry) => entry.settled).length
	}),
)
vi.mock('../tui/index.js', () => ({ launchTui }))

const { runCli } = await import('../cli.js')

describe('the launch starts a background Zen catalogue refresh', () => {
	const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
	const originalRefresh = process.env.NAMZU_MODEL_CATALOGUE_REFRESH

	beforeEach(() => {
		started.length = 0
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
		expect(started).toHaveLength(1)
		expect(started[0]?.signal.aborted).toBe(true)
		expect(started[0]?.settled).toBe(true)
	})

	it('starts nothing when the operator turned it off', async () => {
		process.env.NAMZU_MODEL_CATALOGUE_REFRESH = '0'
		await expect(runCli({ argv: ['node', 'namzu'] })).resolves.toBe(0)
		expect(launchTui).toHaveBeenCalledOnce()
		expect(started).toHaveLength(0)
	})
})
