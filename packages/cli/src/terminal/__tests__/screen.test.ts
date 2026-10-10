import { describe, expect, it } from 'vitest'
import { HeadlessScreen } from '../screen.js'

// A long prompt that soft-wraps at the host's width, then the program repaints it after a
// resize with relative cursor moves (what Windows' console does): up to the prompt's first row,
// to column 0, and the prompt again. The repaint is only right if the viewer's cursor and wraps
// were those of the host's screen when the program last drew.
const PROMPT = `C:\\${'x'.repeat(96)}>`

async function viewerLines(
	viewerCols: number,
	restoreAt: number,
	prompt = PROMPT,
): Promise<string[]> {
	const repaint = `\x1b[1A\r${prompt}`
	const host = new HeadlessScreen(80, 8, 100)
	host.write(`\r\n${prompt}`)
	await host.settled()
	const snapshot = host.serialize(100, 100_000)

	const viewer = new HeadlessScreen(restoreAt, 8, 100)
	viewer.write(snapshot)
	await viewer.settled()
	viewer.resize(viewerCols, 8)
	viewer.write(`${repaint}echo hi`)
	await viewer.settled()
	return viewer.lines()
}

async function hostLines(viewerCols: number, prompt = PROMPT): Promise<string[]> {
	const repaint = `\x1b[1A\r${prompt}`
	const host = new HeadlessScreen(80, 8, 100)
	host.write(`\r\n${prompt}`)
	await host.settled()
	host.resize(viewerCols, 8)
	host.write(`${repaint}echo hi`)
	await host.settled()
	return host.lines()
}

describe('restoring a screen into a view of another width', () => {
	it('matches the host when the view first takes the host width, then resizes', async () => {
		for (const cols of [40, 60, 87, 100, 120]) {
			expect(await viewerLines(cols, 80)).toEqual(await hostLines(cols))
		}
	})

	it('goes wrong when the view is drawn at its own width instead (the old behaviour)', async () => {
		expect(await viewerLines(40, 40)).not.toEqual(await hostLines(40))
	})

	it('keeps the prompt ">" when the first command is typed after it', async () => {
		const lines = await viewerLines(87, 80)
		expect(lines.join('\n')).toContain('>echo hi')
	})

	// Prompts at the edges of a wrap: exactly the width, one over, two wraps, and a wide character
	// (CJK, emoji) that straddles the wrap.
	const edges: Record<string, string> = {
		'exactly the width': `C:\\${'x'.repeat(77)}>`,
		'one over the width': `C:\\${'x'.repeat(78)}>`,
		'two wraps': `C:\\${'x'.repeat(170)}>`,
		'a wide character at the wrap': `C:\\${'x'.repeat(77)}\u65e5\u672c>`,
		'an emoji at the wrap': `C:\\${'x'.repeat(77)}\u{1f600}>`,
	}
	for (const [name, prompt] of Object.entries(edges)) {
		it(`matches the host for a prompt that is ${name}`, async () => {
			for (const cols of [40, 87, 120]) {
				expect(await viewerLines(cols, 80, prompt)).toEqual(await hostLines(cols, prompt))
			}
		})
	}
})
