/** The startup header names the working folder under the version, like a welcome header. */

import { afterEach, expect, it } from 'vitest'

import { BrandHeader } from '../BrandHeader.js'
import { type Screen, renderToScreen } from './support/screen.js'

let mounted: Screen | null = null
afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

async function header(cols: number, cwd: string | undefined): Promise<string[]> {
	const screen = await renderToScreen(
		<BrandHeader version="1.2.3" permissionMode="prompt" cwd={cwd} />,
		{ cols, rows: 24 },
	)
	mounted = screen
	await screen.waitForRender()
	return screen.viewport()
}

it('shows the folder on the row under the version', async () => {
	const rows = await header(100, '/srv/work/namzu')
	const versionRow = rows.findIndex((row) => row.includes('Namzu v1.2.3 · by Cogitave'))
	expect(versionRow).toBeGreaterThanOrEqual(0)
	expect(rows[versionRow + 1]).toContain('/srv/work/namzu')
})

it('shortens a long folder from the left and never wraps', async () => {
	const long = '/srv/work/a-very-long-parent-folder/another-long-folder/namzu/packages/cli'
	const rows = await header(60, long)
	const folderRow = rows.find((row) => row.includes('packages/cli'))
	expect(folderRow).toBeDefined()
	expect(folderRow).toContain('…')
	expect(folderRow?.trimEnd().length).toBeLessThanOrEqual(60)
})

it('draws no folder row when none is given', async () => {
	const rows = await header(100, undefined)
	expect(rows.join('\n')).not.toContain('/srv')
})

it('cuts a long folder on a separator and shows it from the home folder', async () => {
	const { homedir } = await import('node:os')
	const rows = await header(100, `${homedir()}/work/namzu`)
	expect(rows.join('\n')).toContain('~/work/namzu')
	const long = '/srv/work/a-very-long-parent-folder/another-long-folder/namzu/packages/cli'
	const narrow = await header(60, long)
	const folderRow = narrow.find((row) => row.includes('packages/cli'))
	// A cut path starts at a folder boundary, never inside a name.
	expect(folderRow).toMatch(/…\/[A-Za-z]/)
})

it('wraps the bypass warning on words, every continuation row at the same indent', async () => {
	const { bypassWarningLines } = await import('../BrandHeader.js')
	const lines = bypassWarningLines('Bypass permissions', 60)
	expect(lines.length).toBeGreaterThan(2)
	expect(lines[0]?.startsWith('Warning:')).toBe(true)
	for (const line of lines.slice(1)) expect(line).toMatch(/^ {2}\S/)
	for (const line of lines) expect(line.length).toBeLessThanOrEqual(57)
	expect(lines.join(' ').replace(/\s+/g, ' ')).toContain('Use /permissions to change this.')
})
