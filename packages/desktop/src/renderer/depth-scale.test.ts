import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = new URL('.', import.meta.url).pathname

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name)
		return statSync(path).isDirectory() ? walk(path) : [path]
	})
}

const files = walk(root).filter((p) => !p.includes('.test.'))
const css = files.filter((p) => p.endsWith('.css') && !p.endsWith('theme.css'))
const tsx = files.filter((p) => p.endsWith('.tsx'))
const theme = readFileSync(join(root, 'theme.css'), 'utf8')

/** Every `prop: value;` declaration in a stylesheet, with comments removed. */
function declarations(path: string, prop: string): string[] {
	const source = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
	return [...source.matchAll(new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;}]+)`, 'g'))].map((m) =>
		(m[1] ?? '').trim(),
	)
}

/** Without var(...) groups, which carry their own fallback and are already on a token. */
const bare = (value: string) => value.replace(/var\([^)]*\)/g, '')

describe('radius, shadow and layer scales', () => {
	it('no radius literal is left outside the scale', () => {
		// 0, 50% (true circles) and 1-3px (scrollbar thumbs, hairline corners) are not a size on the scale.
		const offenders: string[] = []
		for (const path of css) {
			for (const value of declarations(path, 'border-radius')) {
				for (const token of bare(value).split(/\s+/).filter(Boolean)) {
					if (token === '0' || token === '50%' || /^[0-3]px$/.test(token)) continue
					offenders.push(`${relative(root, path)}: border-radius ${value}`)
				}
			}
		}
		expect(offenders).toEqual([])
	})

	it('no elevation shadow literal is left outside the scale', () => {
		// Allowed literals draw an edge, not an elevation: no blur (a ring or a 1px line), or an inset.
		const allowed = (layer: string) => {
			if (layer === 'none' || layer.startsWith('inset') || layer.startsWith('var(')) return true
			const blur = layer.split(/\s+(?![^(]*\))/)[2]
			return blur === '0' || blur === '0px'
		}
		const edgeOnly = [
			// a thumb knob drawn over a gradient needs its own contrast ring
			'composer-effort-panel.css',
			// a panel edge that slides in from the right, it has a direction the scale does not
			'file-panel/file-panel.css',
		]
		const offenders: string[] = []
		for (const path of css) {
			if (edgeOnly.includes(relative(root, path))) continue
			for (const value of declarations(path, 'box-shadow')) {
				const layers = value.split(/,(?![^(]*\))/).map((l) => l.trim())
				if (layers.every((layer) => allowed(layer))) continue
				offenders.push(`${relative(root, path)}: box-shadow ${value}`)
			}
		}
		expect(offenders).toEqual([])
	})

	it('components take dialog and popover elevation from the tokens', () => {
		// Tailwind's own sizes (shadow-sm to shadow-2xl) and the two old literals are elevation outside the scale.
		const stock = /\bshadow-(?:sm|md|lg|xl|2xl)\b|shadow-\[0_1[68]px_4[04]px/
		const allowed: Record<string, string> = {
			'ui/button.tsx': 'a 1px edge on a pill or dark-on-photo button, not a raised surface',
			'ui/empty.tsx': 'a 5%-alpha hairline under a 36px icon tile',
			'ui/popover.tsx':
				'the tooltip-styled hint at 5% alpha; every real popover takes --shadow-popover',
			'ui/tooltip.tsx': 'the plain tooltip at 5% alpha; the glass one takes --shadow-popover',
		}
		const offenders = tsx.filter(
			(p) => stock.test(readFileSync(p, 'utf8')) && !(relative(root, p) in allowed),
		)
		expect(offenders.map((p) => relative(root, p))).toEqual([])
	})

	it('z-index is a named tier, or a local value from -1 to 10', () => {
		const offenders: string[] = []
		for (const path of css) {
			for (const value of declarations(path, 'z-index')) {
				if (/^var\(|^calc\(/.test(value)) continue
				if (/^-?\d+$/.test(value) && Number(value) >= -1 && Number(value) <= 10) continue
				offenders.push(`${relative(root, path)}: z-index ${value}`)
			}
		}
		for (const path of tsx) {
			for (const m of readFileSync(path, 'utf8').matchAll(/\bz-\[(\d+)\]/g)) {
				offenders.push(`${relative(root, path)}: z-[${m[1]}]`)
			}
		}
		expect(offenders).toEqual([])
	})

	it('orders the tiers so a tooltip and a toast read over a dialog', () => {
		const tier = (name: string) => {
			const found = new RegExp(`${name}: (\\d+);`).exec(theme)
			if (!found?.[1]) throw new Error(`missing ${name}`)
			return Number(found[1])
		}
		const order = [
			'--z-titlebar',
			'--z-overlay-scrim',
			'--z-overlay',
			'--z-scrim',
			'--z-dialog',
			'--z-dialog-top',
			'--z-popover',
			'--z-tooltip',
			'--z-toast',
		].map(tier)
		expect(order).toEqual([...order].sort((a, b) => a - b))
		expect(new Set(order).size).toBe(order.length)
	})
})
