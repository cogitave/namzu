/**
 * Where the pointer is reported in full, the footer's mode, effort and model items answer a click
 * (the mode cycles, the other two open their choosers) and are underlined while the pointer is on
 * them. Driven by pointer reports on an emulated screen, through the registry the launcher feeds.
 */

import { afterEach, expect, it, vi } from 'vitest'

// Colour on, so an underline can be told from none.
vi.hoisted(() => {
	process.env.FORCE_COLOR = '3'
})

import { StatusBar } from '../StatusBar.js'
import type { PointerReport } from '../fullscreen/mouse-wheel.js'
import { PointerRegionsContext } from '../pointer/context.js'
import { createPointerRegions } from '../pointer/regions.js'
import { type Screen, renderToScreen } from './support/screen.js'

const COLS = 120
let mounted: Screen | null = null
afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

async function mount(options: { clicks?: boolean } = {}) {
	const regions = createPointerRegions()
	const did: string[] = []
	const screen = await renderToScreen(
		<PointerRegionsContext.Provider value={regions}>
			<StatusBar
				provider="a-provider"
				model="a-model"
				effort="high"
				state="idle"
				permissionMode="accept-edits"
				canCycleMode
				{...(options.clicks === false
					? {}
					: {
							onClickItem: {
								mode: () => did.push('mode'),
								effort: () => did.push('effort'),
								model: () => did.push('model'),
							},
						})}
			/>
		</PointerRegionsContext.Provider>,
		{ cols: COLS, rows: 4, alternateScreen: true, incrementalRendering: true },
	)
	mounted = screen
	await screen.waitForRender()
	const row = (screen.viewport()[0] ?? '') as string
	const at = (text: string) => ({ x: row.indexOf(text) + 1, y: 1 })
	const send = async (report: PointerReport) => {
		const before = screen.writes().length
		const took = regions.handle(report)
		await screen.waitForRender()
		return { took, wrote: screen.writes().slice(before).join('') }
	}
	const click = async (x: number, y: number) => {
		await send({ kind: 'press', x, y })
		await send({ kind: 'release', x, y })
	}
	return { screen, row, at, send, click, did }
}

it('cycles the mode on a click on it, and opens the choosers from the effort and the model', async () => {
	const m = await mount()
	expect(m.row).toContain('accept edits on')
	await m.click(m.at('accept edits').x + 3, 1)
	await m.click(m.at('effort high').x + 2, 1)
	await m.click(m.at('a-model').x + 2, 1)
	expect(m.did).toEqual(['mode', 'effort', 'model'])
})

it('does nothing for a click between the items', async () => {
	const m = await mount()
	const gap = m.row.indexOf('(shift+tab to cycle)') + 'shift+tab to cycle)'.length + 3
	await m.click(gap, 1)
	expect(m.did).toEqual([])
})

it('underlines the item under the pointer, once, and puts it out when the pointer leaves', async () => {
	const m = await mount()
	const effort = m.at('effort high')
	const first = await m.send({ kind: 'move', x: effort.x + 1, y: 1 })
	expect(first.wrote).toContain('\u001b[4m')
	expect((await m.send({ kind: 'move', x: effort.x + 3, y: 1 })).wrote).toBe('')
	const off = await m.send({ kind: 'move', x: 1, y: 3 })
	expect(off.wrote).not.toBe('')
})

it('is plain where the items do nothing', async () => {
	const m = await mount({ clicks: false })
	const mode = m.at('accept edits')
	await m.click(mode.x + 2, 1)
	expect((await m.send({ kind: 'move', x: mode.x + 2, y: 1 })).wrote).toBe('')
})
