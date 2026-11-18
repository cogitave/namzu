/**
 * Where the pointer is reported in full, a click on a row of the permission prompt chooses that
 * answer, as the digit on it does, and a row lights while the pointer is over it. Driven by pointer
 * reports on an emulated screen, through the same registry the launcher feeds.
 */

import { afterEach, expect, it } from 'vitest'

import { PermissionOverlay } from '../PermissionOverlay.js'
import type { PermissionToolCall } from '../agent.js'
import type { PointerReport } from '../fullscreen/mouse-wheel.js'
import { buildPermissionReview, buildPermissionSummary } from '../permission-review.js'
import { PointerRegionsContext } from '../pointer/context.js'
import { createPointerRegions } from '../pointer/regions.js'
import { type Screen, renderToScreen } from './support/screen.js'

const COLS = 90
const ROWS = 24
const shell: PermissionToolCall = {
	id: 'c',
	name: 'bash',
	input: { command: 'git status' },
	isDestructive: false,
}

let mounted: Screen | null = null
afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

async function mount(options: { pointer?: boolean } = {}) {
	const regions = createPointerRegions()
	const chosen: number[] = []
	const review = buildPermissionReview([shell])
	if (!review.ok) throw new Error('fixture must be representable')
	const screen = await renderToScreen(
		<PointerRegionsContext.Provider value={options.pointer === false ? null : regions}>
			<PermissionOverlay
				toolCalls={[shell]}
				review={review.text}
				summary={buildPermissionSummary(review.text)}
				detailsOpen={false}
				columns={COLS}
				rows={ROWS}
				mode="prompt"
				commandArguments={new Map([['bash', 'command']])}
				rememberWhere="~/project"
				{...(options.pointer === false ? {} : { onChoose: (index: number) => chosen.push(index) })}
			/>
		</PointerRegionsContext.Provider>,
		{ cols: COLS, rows: ROWS, alternateScreen: true, incrementalRendering: true },
	)
	mounted = screen
	await screen.waitForRender()
	const at = (text: string) => {
		const y = screen.viewport().findIndex((row) => row.includes(text)) + 1
		return { y, x: screen.viewport()[y - 1]?.indexOf(text) ?? -1 }
	}
	const send = async (report: PointerReport) => {
		const took = regions.handle(report)
		await screen.waitForRender()
		return took
	}
	return { screen, chosen, at, send }
}

it('chooses the answer that was clicked, on any of the rows', async () => {
	const { chosen, at, send } = await mount()
	const yes = at('1. Yes')
	const rule = at("2. Yes, and don't ask again")
	const no = at('No, and tell Namzu')
	expect(yes.y).toBeGreaterThan(0)
	expect(rule.y).toBeGreaterThan(0)
	// the remembered answer is a row a click can choose too
	for (const target of [no, rule, yes]) {
		await send({ kind: 'press', x: target.x + 4, y: target.y })
		await send({ kind: 'release', x: target.x + 4, y: target.y })
	}
	expect(chosen).toEqual([2, 1, 0])
})

it('lights the row under the pointer and puts it out when the pointer leaves', async () => {
	const { screen, at, send } = await mount()
	const rule = at("2. Yes, and don't ask again")
	const line = () => screen.viewport()[rule.y - 1]
	expect(line()).toMatch(/│ {3}2\. Yes/)
	await send({ kind: 'move', x: rule.x + 6, y: rule.y })
	expect(line()).toMatch(/│ › 2\. Yes/)
	// the others stay as they were, and the cursor's own row keeps its marker
	expect(screen.viewport().join('\n')).toContain('❯ 1. Yes')
	await send({ kind: 'move', x: 1, y: 1 })
	expect(line()).toMatch(/│ {3}2\. Yes/)
})

it('does nothing for a click that went down on one row and came up on another', async () => {
	const { chosen, at, send } = await mount()
	const yes = at('1. Yes')
	const no = at('No, and tell Namzu')
	await send({ kind: 'press', x: yes.x + 4, y: yes.y })
	await send({ kind: 'release', x: no.x + 4, y: no.y })
	expect(chosen).toEqual([])
})

it('leaves the rows plain where the pointer is not reported', async () => {
	const { screen } = await mount({ pointer: false })
	expect(screen.viewport().join('\n')).not.toContain('click')
})
