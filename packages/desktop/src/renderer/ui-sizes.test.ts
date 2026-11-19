import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The sizes standard (docs/cli/desktop-ui-sizes.md) as checks. type-scale.test.ts keeps every font
// size and weight on the scale; this file keeps the things that test cannot see: a size class that
// names nothing, text that inherits the root size, an icon above 16 px in a bar, a filled accent
// circle, and a heavy weight on an alert.

const dir = fileURLToPath(new URL('.', import.meta.url))

function files(root: string, ext: RegExp): string[] {
	const out: string[] = []
	for (const name of readdirSync(root)) {
		const path = join(root, name)
		if (statSync(path).isDirectory()) out.push(...files(path, ext))
		else if (ext.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
	}
	return out
}

type Declaration = { file: string; selector: string; prop: string; value: string }

/** Every declaration of a stylesheet with the selector it sits under; at-rule preludes are skipped. */
function declarations(file: string): Declaration[] {
	const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
	const out: Declaration[] = []
	const stack: string[] = []
	let buffer = ''
	let depth = 0
	const flush = () => {
		const colon = buffer.indexOf(':')
		if (colon > 0 && stack.length > 0) {
			out.push({
				file: file.slice(dir.length),
				selector: ([...stack].reverse().find((s) => !s.startsWith('@')) ?? '').trim(),
				prop: buffer.slice(0, colon).trim(),
				value: buffer.slice(colon + 1).trim(),
			})
		}
		buffer = ''
	}
	for (const ch of css) {
		if (ch === '(') depth++
		if (ch === ')') depth--
		if (depth === 0 && ch === '{') {
			stack.push(buffer.trim().replace(/\s+/g, ' '))
			buffer = ''
		} else if (depth === 0 && ch === '}') {
			flush()
			stack.pop()
		} else if (depth === 0 && ch === ';') flush()
		else buffer += ch
	}
	return out
}

const css = files(dir, /\.css$/).flatMap(declarations)
const sources = files(dir, /\.tsx?$/).map((path) => ({
	file: path.slice(dir.length),
	text: readFileSync(path, 'utf8'),
}))

describe('text size classes', () => {
	const theme = readFileSync(join(dir, 'theme.css'), 'utf8')
	const defined = new Set([...theme.matchAll(/^\s*--text-([a-z0-9]+):/gm)].map((m) => m[1]))

	it('reads the tokens it checks against', () => {
		expect([...defined]).toEqual(expect.arrayContaining(['xs', 'sm', 'base', 'lg', 'xl']))
	})

	it('has no text-ui-* class: those names were never defined and the class did nothing', () => {
		const hits = sources.filter((s) => /(?<![\w-])text-ui-[a-z]+/.test(s.text)).map((s) => s.file)
		expect(hits).toEqual([])
	})

	it('names only text sizes that theme.css defines', () => {
		const hits: string[] = []
		for (const s of sources) {
			for (const m of s.text.matchAll(/(?<![\w-])text-(xs|sm|base|lg|[2-9]?xl)(?![\w-])/g)) {
				if (!defined.has(m[1] ?? '')) hits.push(`${s.file}: ${m[0]}`)
			}
		}
		expect(hits).toEqual([])
	})
})

describe('the root of the text', () => {
	it('sets the body to the interface size, so no text inherits the 16 px root', () => {
		const body = css.filter((d) => d.file === 'style.css' && d.selector === 'body')
		expect(body.find((d) => d.prop === 'font-size')?.value).toBe('var(--text-interface)')
		expect(body.find((d) => d.prop === 'line-height')?.value).toBe('var(--leading-interface)')
	})
})

describe('icon sizes in bars', () => {
	// A toolbar, rail, tab bar, foot or the composer row draws its icons at 12, 14 or 16 px.
	const BAR =
		/rail|sidebar-foot|conversation-tab|conversation-bar|composer-add|toolbar|topbar|pane-actions/
	const ICON = /\bsvg\b|-icon\b|-mark\b/
	const SIZES = new Set(['12px', '14px', '16px', 'var(--frame-icon-slot)'])
	/** Sizes kept off the rule, each with the reason. */
	const ALLOW: { file: string; selector: RegExp; reason: string }[] = [
		{
			file: 'conversation-tabs.css',
			selector: /mark/,
			reason: 'A Pal is a drawn character, 16 wide and 18 high, not a glyph.',
		},
	]

	it('finds the declarations it checks', () => {
		expect(
			css.filter((d) => BAR.test(d.selector) && ICON.test(d.selector) && d.prop === 'width').length,
		).toBeGreaterThan(3)
	})

	it('draws every icon in those places at 12, 14 or 16 px', () => {
		const hits = css
			.filter(
				(d) =>
					BAR.test(d.selector) &&
					ICON.test(d.selector) &&
					(d.prop === 'width' || d.prop === 'height') &&
					/^\d+(\.\d+)?px$|^var\(--frame-icon-slot\)$/.test(d.value) &&
					!SIZES.has(d.value) &&
					!ALLOW.some((a) => a.file === d.file && a.selector.test(d.selector)),
			)
			.map((d) => `${d.file} ${d.selector} { ${d.prop}: ${d.value} }`)
		expect(hits).toEqual([])
	})

	it('gives every control icon one size, 16 px, with no 18 px step for a narrow window', () => {
		const button = readFileSync(join(dir, 'ui/button.tsx'), 'utf8')
		expect(button).toContain("[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none")
		const walk = (d: string): string[] =>
			readdirSync(d, { withFileTypes: true }).flatMap((e) =>
				e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.tsx') ? [join(d, e.name)] : [],
			)
		// ui/empty.tsx draws a 36 px feature tile whose glyph is deliberately 18 px.
		const hits = walk(dir)
			.filter((f) => !f.endsWith(join('ui', 'empty.tsx')))
			.filter((f) => /size-4\.5|size-5 sm:/.test(readFileSync(f, 'utf8')))
		expect(hits).toEqual([])
	})
})

describe('accent fill', () => {
	/**
	 * A filled accent circle is allowed on the send button, on a selected switch or radio and as a
	 * dot of 8 px or less. A button or a badge is not.
	 */
	const ALLOW =
		/send|switch|radio|choice|mark|::after|::before|spinner|stop|thumb|typing|avatar|point|\[data-/
	it('has no filled accent circle that is a button or a badge', () => {
		const groups = new Map<string, Declaration[]>()
		for (const d of css) {
			const key = `${d.file}\u0000${d.selector}`
			groups.set(key, [...(groups.get(key) ?? []), d])
		}
		const hits: string[] = []
		for (const [key, list] of groups) {
			const circle = list.some((d) => d.prop === 'border-radius' && d.value === '50%')
			const filled = list.some(
				(d) => /^background(-color)?$/.test(d.prop) && /var\(--primary\)/.test(d.value),
			)
			const selector = key.split('\u0000')[1] ?? ''
			const width = Number.parseFloat(list.find((d) => d.prop === 'width')?.value ?? '99')
			const dot = width <= 8
			if (circle && filled && !dot && !ALLOW.test(selector)) hits.push(key.replace('\u0000', ' '))
		}
		expect(hits).toEqual([])
	})

	it('shows a waiting update as a rail button with a dot, never a filled badge', () => {
		const rail = css.filter((d) => d.file === 'navigation-rail.css')
		const badge = rail.filter((d) => d.selector === '.rail-update-badge')
		expect(badge.some((d) => /^background/.test(d.prop))).toBe(false)
		expect(rail.some((d) => d.selector === '.rail-update-button')).toBe(false)
	})
})

describe('alerts and banners', () => {
	const ALERT = /alert|banner|notice|error/
	it('never set a heavy weight (600) on the text of an alert', () => {
		// A sentence is 400 and a title line inside an alert 500; nothing in one is 600.
		const hits = css
			.filter(
				(d) =>
					ALERT.test(d.selector) &&
					!/\bh[1-6]\b|title|heading/.test(d.selector) &&
					d.prop === 'font-weight' &&
					d.value !== 'var(--weight-text)' &&
					d.value !== 'var(--weight-control)' &&
					d.value !== '400' &&
					d.value !== '500',
			)
			.map((d) => `${d.file} ${d.selector} { font-weight: ${d.value} }`)
		expect(hits).toEqual([])
	})

	it('keeps the error banner at body size and normal weight, with no blur', () => {
		const banner = sources.find((s) => s.file === 'chat-error-banner.tsx')?.text ?? ''
		expect(banner).not.toMatch(/font-(medium|semibold|bold)/)
		expect(banner).not.toMatch(/backdrop-blur/)
		expect(banner).toMatch(/text-base/)
		expect(banner).not.toMatch(/text-(lg|xl|[2-9]xl)/)
	})
})
