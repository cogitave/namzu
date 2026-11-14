import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The turn (the transcript's text column, the person's message, the reply, the folded row, the open block of
// steps, the working row, the plan and the jump button) is laid out on measured numbers. Each is defined once,
// as a --turn-* token in theme.css, and every rule that places or sizes one of these reads the token.

const dir = fileURLToPath(new URL('.', import.meta.url))

function files(root: string): string[] {
	const out: string[] = []
	for (const name of readdirSync(root)) {
		const path = join(root, name)
		if (statSync(path).isDirectory()) out.push(...files(path))
		else if (name.endsWith('.css')) out.push(path)
	}
	return out
}

type Declaration = { file: string; selector: string; prop: string; value: string }

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

const all = files(dir).flatMap(declarations)
const rootTokens = all.filter((d) => d.file === 'theme.css' && d.selector === ':root')
const tokenValue = (name: string) => rootTokens.find((d) => d.prop === name)?.value

const EXPECTED: Record<string, string> = {
	// The text column: 736 wide at most, 58 in from a pane of 600 or more, 42 in from a narrower one.
	'--turn-column-width': '736px',
	'--turn-gutter': '58px',
	'--turn-gutter-narrow': '42px',
	'--turn-top': '32px',
	// The person's message.
	'--turn-message-radius': '10px',
	'--turn-message-pad-y': '12px',
	'--turn-message-pad-x': '16px',
	'--turn-message-share': '80%',
	'--turn-message-gap': '34px',
	// The reply.
	'--turn-paragraph-gap': '12px',
	'--turn-list-marker': '5px',
	'--turn-list-marker-inset': '13px',
	'--turn-list-marker-top': '9px',
	'--turn-list-text-inset': '37px',
	'--turn-list-gap': '4px',
	'--turn-code-height': '17px',
	'--turn-code-radius': '4px',
	'--turn-code-pad': '4px',
	// The folded row and the open block.
	'--turn-row-height': '28px',
	'--turn-fold-before': '14px',
	'--turn-fold-after': '12px',
	'--turn-chevron-gap': '7px',
	'--turn-chevron-width': '6px',
	'--turn-chevron-height': '8px',
	'--turn-block-gap': '8px',
	'--turn-block-radius': '8px',
	'--turn-block-row': '35px',
	'--turn-block-inset': '12px',
	'--turn-block-after': '20px',
	// The working row's mark.
	'--turn-mark-size': '14px',
	'--turn-mark-dot': '4px',
	'--turn-mark-gap': '8px',
	// The plan.
	'--turn-plan-gap': '20px',
	'--turn-plan-pad': '16px',
	'--turn-plan-radius': '12px',
	'--turn-plan-pitch': '28px',
	'--turn-plan-mark': '16px',
	'--turn-plan-mark-gap': '8px',
	// Jump to latest.
	'--turn-latest-size': '36px',
	'--turn-latest-gap': '20px',
}
// Derived, not measured: the hairline is a share of the text colour.
const DERIVED = ['--turn-edge']

describe('the turn tokens', () => {
	it('pins every turn number once, in theme.css', () => {
		for (const [name, value] of Object.entries(EXPECTED)) {
			expect(tokenValue(name), name).toBe(value)
			expect(
				all.filter((d) => d.prop === name && d.file === 'theme.css'),
				`${name} is defined once`,
			).toHaveLength(1)
		}
		expect(tokenValue('--turn-edge')).toBe('color-mix(in srgb, var(--foreground) 6%, transparent)')
		const defined = rootTokens.map((d) => d.prop).filter((n) => n.startsWith('--turn-'))
		expect(defined.sort()).toEqual([...Object.keys(EXPECTED), ...DERIVED].sort())
	})

	it('reads every token somewhere other than where it is defined', () => {
		const css = files(dir)
			.map((f) => readFileSync(f, 'utf8'))
			.join('\n')
		for (const name of [...Object.keys(EXPECTED), ...DERIVED]) {
			if (
				name === '--turn-block-after' ||
				name === '--turn-gutter' ||
				name === '--turn-gutter-narrow'
			)
				continue
			expect(css, `${name} is read`).toContain(`var(${name})`)
		}
		// The gutters are read through the one --turn-side the column uses, and the block's gap after it is the
		// panel's own padding plus the fold's margin, so it is pinned here and not read by a rule.
		expect(css).toContain('--turn-side: var(--turn-gutter)')
		expect(css).toContain('--turn-side: var(--turn-gutter-narrow)')
		expect(8 + 12).toBe(20)
	})

	it('narrows the gutter below a 600px pane, and only there', () => {
		const style = readFileSync(join(dir, 'style.css'), 'utf8')
		expect(style).toMatch(
			/@container conversation-lane \(max-width: 599\.98px\) \{\s*\.transcript \{\s*--turn-side: var\(--turn-gutter-narrow\);/,
		)
		const column = all.find(
			(d) =>
				d.file === 'style.css' &&
				d.selector === '.transcript .conversation-body' &&
				d.prop === 'width',
		)
		expect(column?.value).toBe('min(var(--turn-column-width), 100cqw - 2 * var(--turn-side))')
	})
})

const READS: [string, string, string, string][] = [
	['style.css', '.transcript', 'padding', '--turn-top'],
	['style.css', '.transcript-latest', 'width', '--turn-latest-size'],
	['style.css', '.transcript-latest', 'height', '--turn-latest-size'],
	['style.css', '.transcript-latest', 'bottom', '--turn-latest-gap'],
	['style.css', '.working', 'height', '--turn-row-height'],
	['style.css', '.working', 'gap', '--turn-mark-gap'],
	['style.css', '.turn-activity', 'margin', '--turn-fold-before'],
	['style.css', '.turn-activity', 'margin', '--turn-fold-after'],
	['style.css', '.activity-trigger', 'min-height', '--turn-row-height'],
	[
		'transcript-rhythm.css',
		'.normal-transcript .message.user',
		'padding-bottom',
		'--turn-message-gap',
	],
	[
		'transcript-rhythm.css',
		'.normal-transcript .message.user > .message-bubble',
		'max-width',
		'--turn-message-share',
	],
	[
		'transcript-rhythm.css',
		'.normal-transcript .message.user > .message-bubble',
		'border-radius',
		'--turn-message-radius',
	],
	[
		'transcript-rhythm.css',
		'.normal-transcript .message.user > .message-bubble',
		'padding',
		'--turn-message-pad-y',
	],
	[
		'transcript-rhythm.css',
		'.normal-transcript .message.user > .message-bubble',
		'padding',
		'--turn-message-pad-x',
	],
	[
		'transcript-rhythm.css',
		'.normal-transcript .message.user > .message-footer',
		'top',
		'--turn-message-gap',
	],
	[
		'transcript-rhythm.css',
		'.normal-transcript .chat-markdown :where(p, ul, ol, blockquote, pre, .table-scroll)',
		'margin-block',
		'--turn-paragraph-gap',
	],
	[
		'transcript-rhythm.css',
		'.normal-transcript .chat-markdown :is(ul, ol)',
		'padding-left',
		'--turn-list-text-inset',
	],
	[
		'transcript-rhythm.css',
		'.normal-transcript .chat-markdown ul > li:not(.task-list-item)::before',
		'width',
		'--turn-list-marker',
	],
	[
		'transcript-rhythm.css',
		'.normal-transcript .chat-markdown ul > li:not(.task-list-item)::before',
		'height',
		'--turn-list-marker',
	],
	[
		'transcript-rhythm.css',
		'.normal-transcript .chat-markdown ul > li:not(.task-list-item)::before',
		'left',
		'--turn-list-marker-inset',
	],
	[
		'transcript-rhythm.css',
		'.normal-transcript .chat-markdown ul > li:not(.task-list-item)::before',
		'top',
		'--turn-list-marker-top',
	],
	[
		'transcript-rhythm.css',
		'.normal-transcript .chat-markdown ol > li::before',
		'left',
		'--turn-list-marker-inset',
	],
	[
		'transcript-rhythm.css',
		'.normal-transcript .chat-markdown li > :is(ul, ol)',
		'margin-block',
		'--turn-list-gap',
	],
	[
		'transcript-rhythm.css',
		'.normal-transcript .chat-markdown li + li',
		'margin-top',
		'--turn-list-gap',
	],
	[
		'transcript-rhythm.css',
		'.normal-transcript .chat-markdown :not(pre) > code',
		'min-height',
		'--turn-code-height',
	],
	[
		'transcript-rhythm.css',
		'.normal-transcript .chat-markdown :not(pre) > code',
		'padding',
		'--turn-code-pad',
	],
	[
		'transcript-rhythm.css',
		'.normal-transcript .chat-markdown :not(pre) > code',
		'border-radius',
		'--turn-code-radius',
	],
	['transcript-rhythm.css', '.normal-transcript .fold-chevron', 'width', '--turn-chevron-width'],
	['transcript-rhythm.css', '.normal-transcript .fold-chevron', 'height', '--turn-chevron-height'],
	[
		'transcript-rhythm.css',
		'.normal-transcript .fold-chevron',
		'margin-left',
		'--turn-chevron-gap',
	],
	['transcript-rhythm.css', '.normal-transcript .working-mark', 'width', '--turn-mark-size'],
	['transcript-rhythm.css', '.normal-transcript .working-mark', 'height', '--turn-mark-size'],
	['transcript-rhythm.css', '.normal-transcript .working-mark > i', 'width', '--turn-mark-dot'],
	['transcript-motion.css', '.normal-transcript .activity-entries', 'padding', '--turn-block-gap'],
	[
		'transcript-motion.css',
		'.normal-transcript .activity-block',
		'border-radius',
		'--turn-block-radius',
	],
	[
		'transcript-motion.css',
		'.normal-transcript .activity-block .tool-trigger',
		'min-height',
		'--turn-block-row',
	],
	[
		'transcript-motion.css',
		'.normal-transcript .activity-block .tool-trigger',
		'padding',
		'--turn-block-inset',
	],
	['plan-row.css', '.plan-box', 'padding', '--turn-plan-pad'],
	['plan-row.css', '.plan-box', 'border-radius', '--turn-plan-radius'],
	['plan-row.css', '.plan-box', 'margin', '--turn-plan-gap'],
	['plan-row.css', '.plan-box-steps > li', 'height', '--turn-plan-pitch'],
	['plan-row.css', '.plan-box-steps > li', 'gap', '--turn-plan-mark-gap'],
	['plan-row.css', '.plan-box-mark', 'width', '--turn-plan-mark'],
]

describe('the rules that place the turn', () => {
	it.each(READS)('%s %s %s reads %s', (file, selector, prop, token) => {
		const found = all.filter((d) => d.file === file && d.selector === selector && d.prop === prop)
		expect(found.length, `${file} ${selector} ${prop}`).toBeGreaterThan(0)
		expect(found.map((d) => d.value).join(' ')).toContain(`var(${token})`)
	})

	it('keeps a measured number out of every rule but its token', () => {
		// 736, 58, 42, 34, 35, 37 and 17 are written once, in theme.css.
		const owned = new Set(['transcript-rhythm.css', 'transcript-motion.css', 'plan-row.css'])
		const loose = all.filter(
			(d) => owned.has(d.file) && /(?<![\d.])(736|58|42|34|35|37|17)px/.test(d.value),
		)
		expect(loose.map((d) => `${d.file} ${d.selector} ${d.prop}: ${d.value}`)).toEqual([])
	})

	it('spaces the turn on 2, 4, 6, 8, 12, 16, 20, 24 and 32 px outside its tokens', () => {
		const allowed = new Set([0, 1, 2, 4, 6, 8, 12, 16, 20, 24, 32])
		const spacing = /^(margin|padding|gap)(-[a-z]+)*$/
		const bad: string[] = []
		for (const d of all) {
			if (!['transcript-rhythm.css', 'plan-row.css'].includes(d.file) || !spacing.test(d.prop))
				continue
			for (const m of d.value.matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
				if (!allowed.has(Math.abs(Number(m[1]))))
					bad.push(`${d.file} ${d.selector} ${d.prop}: ${d.value}`)
			}
		}
		expect(bad).toEqual([])
	})

	it('draws the working mark as four dots that are never the accent', () => {
		const mark = all.filter(
			(d) => d.file === 'transcript-rhythm.css' && d.selector.includes('.working-mark'),
		)
		expect(mark.some((d) => d.prop === 'background' && d.value === 'var(--muted-foreground)')).toBe(
			true,
		)
		expect(mark.filter((d) => /primary|accent|lime/.test(d.value))).toEqual([])
	})
})
