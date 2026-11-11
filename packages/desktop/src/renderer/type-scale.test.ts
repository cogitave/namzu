import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The renderer draws text at seven sizes and three weights, all defined once in theme.css. This test
// reads every stylesheet and every component and fails when a size or a weight is added off the scale,
// so the scale cannot drift one literal at a time.

const dir = fileURLToPath(new URL('.', import.meta.url))

function files(root: string, ext: RegExp): string[] {
	const out: string[] = []
	for (const name of readdirSync(root)) {
		const path = join(root, name)
		if (statSync(path).isDirectory()) out.push(...files(path, ext))
		else if (ext.test(name) && !name.endsWith('.test.ts')) out.push(path)
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
				selector: [...stack].reverse().find((s) => !s.startsWith('@')) ?? '',
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

const all = files(dir, /\.css$/).flatMap(declarations)

const SCALE_PX = new Set(['12px', '13px', '14px', '15px', '17px', '20px', '28px'])
const TOKEN =
	/^var\(--(text-(caption|small|interface|reading|heading|title|display)|font-size-code)\)$/
const RELATIVE = /^(0\.9em|1em|inherit|initial|unset)$/

/** The sizes kept off the scale, each with the reason it cannot move. */
const SIZE_ALLOW: { file: string; selector: RegExp; reason: string }[] = [
	{
		file: 'style.css',
		selector: /^\.namzu-wordmark|^\.sidebar \.namzu-wordmark/,
		reason: 'The pixel wordmark is drawn from block characters; its size sets its pixel grid.',
	},
	{
		file: 'composer.css',
		selector: /namzu-wordmark/,
		reason: 'The wordmark inside a 16 px mark is sized to the mark, not to text.',
	},
	{
		file: 'conversation-tabs.css',
		selector: /namzu-wordmark/,
		reason: 'The wordmark inside a tab mark is sized to the mark, not to text.',
	},
	{
		file: 'terminal-pane.css',
		selector: /namzu-wordmark/,
		reason: 'The wordmark inside a terminal mark is sized to the mark, not to text.',
	},
	{
		file: 'theme.css',
		selector: /^:root$/,
		reason:
			'The root size is the rem base (16 px) that every rem length in the renderer is measured from.',
	},
]

const allowed = (d: Declaration, list: { file: string; selector: RegExp }[]) =>
	list.some((a) => a.file === d.file && a.selector.test(d.selector))

describe('type scale', () => {
	it('finds the declarations it checks', () => {
		expect(all.filter((d) => d.prop === 'font-size').length).toBeGreaterThan(200)
		expect(all.filter((d) => d.prop === 'font-weight').length).toBeGreaterThan(100)
	})

	it('defines the seven sizes and three weights once, in theme.css', () => {
		const theme = new Map(
			all
				.filter((d) => d.file === 'theme.css' && d.selector === ':root')
				.map((d) => [d.prop, d.value]),
		)
		const sizes: [string, string, string][] = [
			['caption', '12px', '16px'],
			['small', '13px', '18px'],
			['interface', '14px', '20px'],
			['reading', '15px', '22px'],
			['heading', '17px', '24px'],
			['title', '20px', '28px'],
			['display', '28px', '36px'],
		]
		for (const [name, size, leading] of sizes) {
			expect(theme.get(`--text-${name}`), name).toBe(size)
			expect(theme.get(`--leading-${name}`), name).toBe(leading)
		}
		expect(theme.get('--weight-text')).toBe('400')
		expect(theme.get('--weight-control')).toBe('500')
		expect(theme.get('--weight-strong')).toBe('600')
	})

	it('keeps code at 13/20 and the diff viewer on the code size', () => {
		const theme = new Map(all.filter((d) => d.file === 'theme.css').map((d) => [d.prop, d.value]))
		expect(theme.get('--font-size-code')).toBe('13px')
		expect(theme.get('--leading-code')).toBe('20px')
		expect(theme.get('--diffs-font-size')).toBe('var(--font-size-code)')
	})

	it('draws every font-size from a token or a value of the scale', () => {
		const bad = all
			.filter((d) => d.prop === 'font-size')
			.filter((d) => !TOKEN.test(d.value) && !SCALE_PX.has(d.value) && !RELATIVE.test(d.value))
			.filter((d) => !allowed(d, SIZE_ALLOW))
			.map((d) => `${d.file}: ${d.selector} { font-size: ${d.value} }`)
		expect(bad).toEqual([])
	})

	it('writes no size inside the font shorthand', () => {
		const bad = all
			.filter((d) => d.prop === 'font' && !/^inherit$/.test(d.value))
			.map((d) => `${d.file}: ${d.selector} { font: ${d.value} }`)
		expect(bad).toEqual([])
	})

	it('has no weight above strong (600)', () => {
		const bad = all
			.filter((d) => d.prop === 'font-weight')
			.filter((d) => {
				if (/^var\(--weight-(text|control|strong)\)$|^inherit$/.test(d.value)) return false
				const n = Number(d.value)
				return !(Number.isFinite(n) && n <= 600)
			})
			.map((d) => `${d.file}: ${d.selector} { font-weight: ${d.value} }`)
		expect(bad).toEqual([])
	})

	it('has no bold or off-scale size class in a component', () => {
		const bad: string[] = []
		for (const file of files(dir, /\.tsx$/)) {
			const text = readFileSync(file, 'utf8')
			for (const m of text.matchAll(/\b(font-(bold|extrabold|black)|text-\[\d[\d.]*(px|rem)\])/g)) {
				bad.push(`${file.slice(dir.length)}: ${m[0]}`)
			}
		}
		expect(bad).toEqual([])
	})
})
