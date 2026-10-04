import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('packages the accessible guest wordmark with the exact canonical desktop and CLI cells', async () => {
	// Read the canonical sources only in this repository test, never in the guest
	// image or sandbox runtime: neither application is a sandbox dependency.
	const [desktop, cli, svg, home] = await Promise.all([
		readFile(new URL('../../../../desktop/src/renderer/wordmark.tsx', import.meta.url), 'utf8'),
		readFile(new URL('../../../../cli/src/tui/logo.ts', import.meta.url), 'utf8'),
		readFile(new URL('../../../local-computer/new-tab/wordmark.svg', import.meta.url), 'utf8'),
		readFile(new URL('../../../local-computer/home.html', import.meta.url), 'utf8'),
	])
	const desktopLettering = desktop.match(/const lettering = '([^']+)'/)?.[1]
	const cliLettering = cli.match(/const NAMZU_WORDMARK = '([^']+)'/)?.[1]
	expect(desktopLettering).toBeDefined()
	expect(cliLettering).toBe(desktopLettering)
	const lettering = desktopLettering!.split('\\n')
	const expected = lettering.flatMap((row) =>
		[0, 1].map((half) =>
			[...row]
				.map((cell) =>
					cell === '█' || (cell === '▀' && half === 0) || (cell === '▄' && half === 1) ? '#' : '.',
				)
				.join(''),
		),
	)
	expect(svg).toContain('viewBox="0 0 21 4"')
	const actual = Array.from({ length: 4 }, () => Array<string>(21).fill('.'))
	const rectangles = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)]
	expect(rectangles.length).toBeGreaterThan(0)
	for (const rectangle of rectangles) {
		const [x, y, width, height] = rectangle.slice(1).map(Number)
		expect(x! + width!).toBeLessThanOrEqual(21)
		expect(y! + height!).toBeLessThanOrEqual(4)
		for (let row = y!; row < y! + height!; row++)
			for (let column = x!; column < x! + width!; column++) {
				expect(actual[row]![column]).toBe('.')
				actual[row]![column] = '#'
			}
	}
	expect(actual.map((row) => row.join(''))).toEqual(expected)
	expect(svg).not.toContain('<text')
	expect(home).toMatch(/<img\b[^>]*src="wordmark\.svg"[^>]*alt="Namzu"/)
})
