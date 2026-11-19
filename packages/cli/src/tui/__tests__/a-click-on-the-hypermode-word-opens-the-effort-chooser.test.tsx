/**
 * Hypermode is named once, on the composer frame's upper rule, and no longer as a footer item. With
 * the pointer reported in full, a click on that word opens the effort chooser, so a session with
 * hypermode on and no explicit effort still has a click to it.
 */

import { afterEach, expect, it } from 'vitest'

import { Text } from 'ink'
import { ComposerFrame } from '../ComposerFrame.js'
import type { PointerReport } from '../fullscreen/mouse-wheel.js'
import { PointerRegionsContext } from '../pointer/context.js'
import { createPointerRegions } from '../pointer/regions.js'
import { type Screen, renderToScreen } from './support/screen.js'

let mounted: Screen | null = null
afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

async function mount(withClick: boolean) {
	const regions = createPointerRegions()
	const did: string[] = []
	const screen = await renderToScreen(
		<PointerRegionsContext.Provider value={regions}>
			<ComposerFrame
				mode="hypermode"
				columns={60}
				{...(withClick ? { onModeClick: () => did.push('effort') } : {})}
			>
				<Text>draft</Text>
			</ComposerFrame>
		</PointerRegionsContext.Provider>,
		{ cols: 60, rows: 6, alternateScreen: true, incrementalRendering: true },
	)
	mounted = screen
	await screen.waitForRender()
	const lines = screen.viewport() as string[]
	const y = lines.findIndex((line) => line.includes('hypermode')) + 1
	const x = (lines[y - 1] ?? '').indexOf('hypermode') + 1
	const click = async (px: number, py: number) => {
		const report = (kind: 'press' | 'release'): PointerReport => ({ kind, x: px, y: py })
		regions.handle(report('press'))
		regions.handle(report('release'))
		await screen.waitForRender()
	}
	return { click, did, x, y }
}

it('opens the effort chooser from a click on the mode word', async () => {
	const m = await mount(true)
	expect(m.y).toBeGreaterThan(0)
	await m.click(m.x + 3, m.y)
	expect(m.did).toEqual(['effort'])
})

it('does nothing for a click on the rule beside it, or where no click is wired', async () => {
	const m = await mount(true)
	await m.click(2, m.y)
	expect(m.did).toEqual([])
	const plain = await mount(false)
	await plain.click(plain.x + 3, plain.y)
	expect(plain.did).toEqual([])
})
