import { homedir } from 'node:os'
import { expect, it } from 'vitest'

import { TrustPrompt } from '../TrustPrompt.js'
import { renderToScreen } from './support/screen.js'

const FOLDER = `${homedir()}/workspaces/@cogitave/cogitave/namzu/packages/some-long-package-name`

it.each([40, 60, 80])('writes the folder as one tidy line at %i columns', async (cols) => {
	const screen = await renderToScreen(<TrustPrompt cwd={FOLDER} />, { cols, rows: 16 })
	try {
		const frame = screen.viewport()
		const pathRows = frame.filter((row) => row.includes('~') || row.includes('package-name'))
		// One row, starting with home as ~, ending with the last folder whole.
		expect(pathRows).toHaveLength(1)
		const row = pathRows[0] ?? ''
		expect(row).toContain('~/')
		expect(row).toContain('some-long-package-name')
		expect(row).not.toContain(homedir())
		// Nothing wrapped: every row stays inside the box.
		for (const line of frame) expect(line.length).toBeLessThanOrEqual(cols)
	} finally {
		await screen.unmount()
	}
})
