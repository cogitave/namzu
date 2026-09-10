import stringWidth from 'string-width'
import { afterEach, expect, it } from 'vitest'
import { StatusPanel } from '../StatusPanel.js'
import { statusPanelLayout } from '../status-panel-layout.js'
import { type Screen, renderToScreen } from './support/screen.js'

let screen: Screen | undefined
afterEach(async () => {
	await screen?.unmount()
	screen = undefined
})
it.each([40, 80, 120])('renders a complete bounded status panel at %i columns', async (columns) => {
	const rows: [string, string][] = [
		['Model', 'gpt-5.6-luna'],
		['Directory', '/home/arda/workspaces/長い名前/namzu/packages/cli'],
		['Permissions', 'Ask before changes'],
		['Session', '12345678-1234-1234-1234-123456789012'],
		['Spend (current or latest run, own calls)', 'at least $0.1200'],
	]
	screen = await renderToScreen(<StatusPanel rows={rows} />, { cols: columns, rows: 45 })
	const lines = screen.viewport().filter((line) => line.trim())
	const text = lines.join('\n')
	expect(text).toContain('NAMZU')
	expect(text).toContain('gpt-5.6-luna')
	expect(text).toContain('at least $0.1200')
	expect(text).not.toContain('```')
	const rightEdges = lines
		.filter((line) => line.includes('│'))
		.map((line) => stringWidth(line.slice(0, line.lastIndexOf('│'))))
	expect(rightEdges.length).toBeGreaterThan(4)
	expect(new Set(rightEdges).size).toBe(1)
	const paintedHeight = screen
		.viewport()
		.reduce((last, line, index) => (line.trim().length > 0 ? index + 1 : last), 0)
	expect(statusPanelLayout(rows, columns).height).toBeGreaterThanOrEqual(paintedHeight)
	const layout = statusPanelLayout(rows, columns)
	expect(layout.rows[1]!.lines.join('')).toBe(rows[1]![1])
})
