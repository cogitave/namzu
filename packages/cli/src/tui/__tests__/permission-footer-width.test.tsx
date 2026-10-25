/** The key to the exact input stays on the prompt's hint line when the terminal is narrow. */

import { expect, it } from 'vitest'

import { PermissionOverlay } from '../PermissionOverlay.js'
import { buildPermissionReview, buildPermissionSummary } from '../permission-review.js'
import { renderToScreen } from './support/screen.js'

it('keeps the key to the exact input in the hint line at 60 columns', async () => {
	const toolCalls = [
		{ id: 'c', name: 'bash', input: { command: 'git status' }, isDestructive: true },
	]
	const review = buildPermissionReview(toolCalls)
	if (!review.ok) throw new Error('fixture must be representable')
	const screen = await renderToScreen(
		<PermissionOverlay
			toolCalls={toolCalls}
			review={review.text}
			summary={buildPermissionSummary(review.text)}
			detailsOpen={false}
			columns={60}
			rows={30}
			mode="prompt"
		/>,
		{ cols: 60, rows: 30 },
	)
	try {
		await screen.waitForRender()
		const hint = screen.viewport().find((row) => row.includes('select'))
		expect(hint).toBeDefined()
		expect(hint).toContain('d input')
		expect(hint).toContain('enter confirm')
		expect(hint).toContain('y / n')
	} finally {
		await screen.unmount()
	}
})
