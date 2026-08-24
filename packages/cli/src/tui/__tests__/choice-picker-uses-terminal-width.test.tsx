import { afterEach, expect, it } from 'vitest'

import { ChoicePicker } from '../ChoicePicker.js'
import { type Screen, renderToScreen } from './support/screen.js'

let mounted: Screen | null = null

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

it('uses available width for a finite choice label before truncating it', async () => {
	const label = 'preserve cancellation ownership'
	mounted = await renderToScreen(
		<ChoicePicker
			title="Select a commit to review"
			options={[
				{
					label,
					description: 'aaaaaaaaaaaa',
				},
			]}
			selected={0}
		/>,
		{ cols: 100, rows: 12 },
	)

	const viewport = mounted.viewport().join('\n')
	expect(viewport).toContain(label)
	expect(viewport).toContain('aaaaaaaaaaaa')
})
