import { Text } from 'ink'
import { expect, it } from 'vitest'

import { renderToScreen } from './support/screen.js'

it('returns the process exit listeners it borrowed, even after repeated teardown', async () => {
	const before = process.rawListeners('beforeExit')
	const screen = await renderToScreen(<Text>ready</Text>)

	await screen.unmount()
	await screen.unmount()

	expect(process.rawListeners('beforeExit')).toEqual(before)
})
