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
				selector: stack.includes('@font-face')
					? '@font-face'
					: ([...stack].reverse().find((s) => !s.startsWith('@')) ?? ''),
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
			// A shipped face declares the range of weights its file can draw, not a weight the app uses.
			.filter((d) => d.prop === 'font-weight' && d.selector !== '@font-face')
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

	it('holds the width of the durations and times in the transcript', () => {
		const tabular = all.filter(
			(d) => d.prop === 'font-variant-numeric' && d.value === 'tabular-nums',
		)
		const selectors = tabular.flatMap((d) => d.selector.split(',').map((s) => s.trim()))
		for (const name of ['.transcript-phase-text', '.transcript-date-separator', '.message-time']) {
			expect(selectors).toContain(name)
		}
	})
})

// The display face (Geist Pixel, shape Square) is a voice for a few large words: the project's name in
// the home heading. It is never used for a sentence, for text a person or a model wrote, or small. The
// token and the face are named in a stylesheet only where this list allows, and a rule that uses them
// may set no size below the title size.
const DISPLAY_USE = /--font-display|Geist Pixel/
const DISPLAY_ALLOW: { file: string; selector: RegExp; reason: string }[] = [
	{
		file: 'theme.css',
		selector: /^:root$|^:root\[data-interface-font="system"\]$|^@font-face$/,
		reason: 'The token, its device fallback and the face are defined once, in theme.css.',
	},
	{
		file: 'composer.css',
		selector: /^\[data-composer-heading\] \.home-heading-name\[data-face="display"\]$/,
		reason: 'The project name inside the home heading, drawn only when the face covers all of it.',
	},
]
const TEXT_OF_PEOPLE_AND_MODELS =
	/chat-markdown|markdown|message|transcript|prose|textarea|input|prompt|reply|user-|assistant|tool-|code|terminal|diff/i
const TITLE_PX = 20
const px = (value: string) => {
	if (value === 'var(--text-title)') return 20
	if (value === 'var(--text-display)') return 28
	const m = /^(\d+(?:\.\d+)?)px$/.exec(value)
	return m ? Number(m[1]) : undefined
}

describe('the display face', () => {
	const uses = all.filter((d) => DISPLAY_USE.test(d.prop) || DISPLAY_USE.test(d.value))

	it('finds the places it checks', () => {
		expect(uses.length).toBeGreaterThan(3)
		expect(uses.some((d) => d.file === 'composer.css')).toBe(true)
	})

	it('is named only in the allow-list of places', () => {
		const bad = uses
			.filter((d) => !allowed(d, DISPLAY_ALLOW))
			.map((d) => `${d.file}: ${d.selector} { ${d.prop}: ${d.value} }`)
		expect(bad).toEqual([])
	})

	it('is never named in a component, which would style it with no size to check', () => {
		const bad: string[] = []
		for (const file of files(dir, /\.tsx?$/)) {
			if (file.endsWith('display-face-coverage.ts')) continue
			const text = readFileSync(file, 'utf8')
			if (DISPLAY_USE.test(text)) bad.push(file.slice(dir.length))
		}
		expect(bad).toEqual([])
	})

	it('is never on a rule that styles text a person or a model wrote', () => {
		const bad = uses
			.filter((d) => d.file !== 'theme.css')
			.filter((d) => TEXT_OF_PEOPLE_AND_MODELS.test(d.selector))
			.map((d) => `${d.file}: ${d.selector}`)
		expect(bad).toEqual([])
	})

	it('is never drawn below the title size', () => {
		// A rule that names the face may set a size, and then it is the title size or larger.
		const selectors = new Set(
			uses.filter((d) => d.file !== 'theme.css').map((d) => `${d.file} ${d.selector}`),
		)
		const small = all
			.filter((d) => d.prop === 'font-size' && selectors.has(`${d.file} ${d.selector}`))
			.filter((d) => (px(d.value) ?? 0) < TITLE_PX)
			.map((d) => `${d.file}: ${d.selector} { font-size: ${d.value} }`)
		expect(small).toEqual([])
		// Where it names no size, it inherits the heading's, which is the display size.
		const heading = readFileSync(join(dir, 'composer.tsx'), 'utf8')
		const classes = /data-composer-heading\s+className="([^"]+)"/.exec(heading)?.[1] ?? ''
		expect(classes).toMatch(/\btext-2xl\b/)
		expect(classes).toMatch(/\bsm:text-3xl\b/)
		expect(classes).not.toMatch(/\btext-(xs|sm|base|lg|xl)\b/)
	})

	it('falls back to the interface face, and to the device font with the setting', () => {
		const theme = new Map(
			all
				.filter((d) => d.file === 'theme.css' && d.selector === ':root')
				.map((d) => [d.prop, d.value]),
		)
		expect(theme.get('--font-display-app')).toBe('"Geist Pixel", var(--font-sans-app)')
		expect(theme.get('--font-display')).toBe('var(--font-display-app)')
		const system = all.find(
			(d) =>
				d.file === 'theme.css' &&
				d.selector === ':root[data-interface-font="system"]' &&
				d.prop === '--font-display',
		)
		expect(system?.value).toBe('var(--font-sans-system)')
	})
})
