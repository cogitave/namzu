import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
const darkStart = css.indexOf('\n.dark {')
const light = css.slice(0, darkStart)

const shared = [
	'--dur-instant',
	'--dur-quick',
	'--dur-base',
	'--dur-sheet',
	'--dur-slow',
	'--ease-out',
	'--ease-snap',
	'--ease-settle',
	'--ease-pop',
	'--placeholder-delay',
	'--radius-chip',
	'--radius-control',
	'--radius-card',
	'--radius-panel',
	'--radius-pill',
	'--z-local',
	'--z-sticky',
	'--z-panel',
	'--z-titlebar',
	'--z-popover',
	'--z-tooltip',
	'--z-dialog',
	'--z-modal-top',
	'--z-toast',
	'--shadow-1',
	'--shadow-2',
	'--shadow-popover',
	'--shadow-dialog',
	'--ring-hairline',
	'--focus-ring',
	'--focus-ring-danger',
	'--ink-1',
	'--ink-2',
	'--ink-3',
	'--ink-4',
]

describe('design tokens', () => {
	it.each(shared)('declares %s', (name) => {
		expect(css).toMatch(new RegExp(`${name}:`))
	})

	it('keeps the original motion values on the old names', () => {
		expect(light).toContain('--motion-duration: 220ms;')
		expect(light).toContain('--motion-ease: cubic-bezier(0.22, 1, 0.36, 1);')
		expect(light).toContain('--control-radius: var(--radius-control);')
	})

	it('redefines the shadows for dark', () => {
		const dark = css.slice(darkStart)
		for (const name of ['--shadow-1', '--shadow-2', '--shadow-popover', '--shadow-dialog']) {
			expect(dark).toMatch(new RegExp(`${name}:`))
		}
	})

	it('orders the dark popover layer between the surface and the raised surface', () => {
		const hex = (name: string) => {
			const found = new RegExp(`${name}: #([0-9a-f]{6});`).exec(css.slice(darkStart))
			if (!found?.[1]) throw new Error(name)
			return Number.parseInt(found[1].slice(0, 2), 16)
		}
		expect(hex('--popover')).toBeGreaterThan(hex('--surface'))
		expect(hex('--popover')).toBeLessThanOrEqual(hex('--surface-raised'))
	})
})
