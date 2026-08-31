import { Text, useWindowSize } from 'ink'
import { expect, it } from 'vitest'

import { renderToScreen } from './support/screen.js'

function Dimensions() {
	const { columns, rows } = useWindowSize()
	return <Text>{columns}x{rows}</Text>
}

it('resizes stdout, the emulator and subscribed components as one operation', async () => {
	const screen = await renderToScreen(<Dimensions />, { cols: 80, rows: 24 })
	try {
		expect(screen.viewport()).toHaveLength(24)
		expect(screen.viewport().join('\n')).toContain('80x24')

		await screen.resize(41, 12)

		expect(screen.viewport()).toHaveLength(12)
		expect(screen.viewport().join('\n')).toContain('41x12')
	} finally {
		await screen.unmount()
	}
})

it('returns the process exit listeners it borrowed, even after repeated teardown', async () => {
	const before = process.rawListeners('beforeExit')
	const screen = await renderToScreen(<Text>ready</Text>)

	await screen.unmount()
	await screen.unmount()

	expect(process.rawListeners('beforeExit')).toEqual(before)
})
