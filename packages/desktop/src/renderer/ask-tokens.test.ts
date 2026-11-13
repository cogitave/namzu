import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The request for permission, the input box's growth, the send and stop controls, the notice above the box and
// the home starters are laid out on measured numbers. Each is defined once, as an --ask-*, --box-*, --notice-* or
// --start-* token in theme.css, and every rule that places or sizes one of these reads the token.

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
	'--ask-pad': '16px',
	'--ask-band': '48px',
	'--ask-path-gap': '10px',
	'--ask-path-height': '43px',
	'--ask-path-radius': '8px',
	'--ask-path-pad': '16px',
	'--ask-preview-gap': '16px',
	'--ask-preview-radius': '8px',
	'--ask-preview-air': '6px',
	'--ask-row': '20px',
	'--ask-line-end': '28px',
	'--ask-code-start': '50px',
	'--ask-bar': '6px',
	'--ask-stripe': '2px',
	'--ask-tint': '22%',
	'--ask-foot-gap': '24px',
	'--ask-button': '28px',
	'--ask-button-radius': '8px',
	'--ask-button-gap': '16px',
	'--ask-split-divider': '14px',
	'--ask-chip-height': '18px',
	'--ask-chip-radius': '4px',
	'--ask-chip-gap': '8px',
	'--box-line': '22px',
	'--box-send': '28px',
	'--box-send-radius': '8px',
	'--box-stop-square': '12px',
	'--box-stop-radius': '2px',
	'--notice-height': '48px',
	'--notice-text-start': '44px',
	'--notice-close': '28px',
	'--notice-close-edge': '10px',
	'--start-width': '320px',
	'--start-height': '40px',
	'--start-gap': '12px',
	'--start-radius': '12px',
	'--start-icon': '16px',
	'--start-icon-start': '12px',
	'--start-icon-gap': '8px',
	'--start-heading-gap': '24px',
}
// Derived, not measured: shares of the text colour.
const DERIVED: Record<string, string> = {
	'--ask-band-radius': 'calc(var(--radius-card) - 1px)',
	'--ask-fill': 'color-mix(in srgb, var(--foreground) 6%, transparent)',
	'--ask-quiet': 'color-mix(in srgb, var(--foreground) 16%, transparent)',
	'--box-hover': 'color-mix(in srgb, var(--foreground) 8%, transparent)',
	'--start-edge': 'color-mix(in srgb, var(--foreground) 8%, transparent)',
}
const PREFIXES = ['--ask-', '--box-', '--notice-', '--start-']

describe('the ask, box and starter tokens', () => {
	it('pins every number once, in theme.css', () => {
		for (const [name, value] of Object.entries({ ...EXPECTED, ...DERIVED })) {
			expect(tokenValue(name), name).toBe(value)
			expect(
				all.filter((d) => d.prop === name && d.file === 'theme.css'),
				`${name} is defined once`,
			).toHaveLength(1)
		}
		const defined = rootTokens
			.map((d) => d.prop)
			.filter((n) => PREFIXES.some((prefix) => n.startsWith(prefix)))
		expect(defined.sort()).toEqual([...Object.keys(EXPECTED), ...Object.keys(DERIVED)].sort())
	})

	it('reads every token somewhere other than where it is defined', () => {
		const css = files(dir)
			.map((f) => readFileSync(f, 'utf8'))
			.join('\n')
		for (const name of [...Object.keys(EXPECTED), ...Object.keys(DERIVED)])
			expect(css, `${name} is read`).toContain(`var(${name})`)
	})
})

const READS: [string, string, string, string][] = [
	['composer-approval.css', '.approval-card', 'padding', '--ask-pad'],
	['composer-approval.css', '.approval-head', 'height', '--ask-band'],
	['composer-approval.css', '.approval-head', 'background', '--ask-fill'],
	['composer-approval.css', '.approval-card > .approval-path', 'height', '--ask-path-height'],
	['composer-approval.css', '.approval-card > .approval-path', 'margin-top', '--ask-path-gap'],
	[
		'composer-approval.css',
		'.approval-card > .approval-path',
		'border-radius',
		'--ask-path-radius',
	],
	['composer-approval.css', '.approval-card > .approval-path', 'padding-inline', '--ask-path-pad'],
	['composer-approval.css', '.approval-card > .approval-box', 'margin-top', '--ask-preview-gap'],
	[
		'composer-approval.css',
		'.approval-card > .approval-box',
		'border-radius',
		'--ask-preview-radius',
	],
	['composer-approval.css', '.approval-rows', 'padding', '--ask-preview-air'],
	['composer-approval.css', '.approval-row', 'min-height', '--ask-row'],
	['composer-approval.css', '.approval-row-line', 'width', '--ask-line-end'],
	['composer-approval.css', '.approval-row-sign', 'width', '--ask-code-start'],
	['composer-approval.css', '.approval-row[data-kind="add"]', 'background', '--ask-tint'],
	['composer-approval.css', '.approval-row[data-kind="remove"]', 'background', '--ask-tint'],
	[
		'composer-approval.css',
		'.approval-row:is([data-kind="add"], [data-kind="remove"])::before',
		'width',
		'--ask-bar',
	],
	[
		'composer-approval.css',
		'.approval-row[data-kind="remove"]::before',
		'background',
		'--ask-stripe',
	],
	['composer-approval.css', '.approval-card > .approval-footer', 'margin-top', '--ask-foot-gap'],
	['composer-approval.css', '.approval-card > .approval-footer', 'gap', '--ask-button-gap'],
	['composer-approval.css', '.approval-actions', 'gap', '--ask-button-gap'],
	['composer-approval.css', '.approval-button', 'height', '--ask-button'],
	['composer-approval.css', '.approval-button', 'border-radius', '--ask-button-radius'],
	['composer-approval.css', '.approval-button', 'background', '--ask-quiet'],
	['composer-approval.css', '.approval-key', 'height', '--ask-chip-height'],
	['composer-approval.css', '.approval-key', 'border-radius', '--ask-chip-radius'],
	['composer-approval.css', '.approval-key', 'margin-left', '--ask-chip-gap'],
	['composer-approval.css', '.approval-split-divider', 'height', '--ask-split-divider'],
	['composer-approval.css', '.approval-split-more', 'width', '--ask-button'],
	['composer.css', '.normal-composer-shell .composer-input textarea', 'min-height', '--box-send'],
	['composer.css', '.normal-composer-shell .composer-input textarea', 'padding', '--box-text-inset'],
	['composer.css', '.composer-send', 'width', '--box-send'],
	['composer.css', '.composer-send', 'border-radius', '--box-send-radius'],
	['composer.css', '.composer-stop', 'width', '--box-send'],
	['composer.css', '.composer-stop:hover:not(:disabled)', 'background', '--box-hover'],
	['composer.css', '.composer-stop-square', 'width', '--box-stop-square'],
	['composer.css', '.composer-stop-square', 'border-radius', '--box-stop-radius'],
	['voice-input.css', '.voice-notice', 'min-height', '--notice-height'],
	['voice-input.css', '.voice-notice', 'padding', '--notice-text-start'],
	['voice-input.css', '.voice-notice', 'padding', '--notice-close-edge'],
	['voice-input.css', '.voice-notice > .voice-notice-close', 'width', '--notice-close'],
	['style.css', '.starter-actions', 'gap', '--start-gap'],
	['style.css', '.starter-actions', 'margin', '--start-heading-gap'],
	['style.css', '.starter-actions button', 'width', '--start-width'],
	['style.css', '.starter-actions button', 'height', '--start-height'],
	['style.css', '.starter-actions button', 'border-radius', '--start-radius'],
	['style.css', '.starter-actions button', 'border', '--start-edge'],
	['style.css', '.starter-actions button', 'padding', '--start-icon-start'],
	['style.css', '.starter-actions button', 'gap', '--start-icon-gap'],
	['style.css', '.starter-actions button:hover', 'background', '--box-hover'],
	['style.css', '.starter-actions svg', 'width', '--start-icon'],
]

describe('the rules that place the ask, the box and the starters', () => {
	it.each(READS)('%s %s %s reads %s', (file, selector, prop, token) => {
		const found = all.filter((d) => d.file === file && d.selector === selector && d.prop === prop)
		expect(found.length, `${file} ${selector} ${prop}`).toBeGreaterThan(0)
		expect(found.map((d) => d.value).join(' ')).toContain(`var(${token})`)
	})

	it('keeps a measured number out of the approval card and the notice but its token', () => {
		const owned = new Set(['composer-approval.css', 'voice-input.css'])
		const loose = all.filter(
			(d) =>
				owned.has(d.file) &&
				/^(--ask|margin|padding|height|min-height|width|gap)/.test(d.prop) &&
				/(?<![\d.])(43|48|50|44)px/.test(d.value),
		)
		expect(loose.map((d) => `${d.file} ${d.selector} ${d.prop}: ${d.value}`)).toEqual([])
	})

	it('has no round send or stop control and no alarm colour on Stop', () => {
		const controls = all.filter(
			(d) => d.file === 'composer.css' && /^\.composer-(send|stop)\b/.test(d.selector),
		)
		expect(controls.filter((d) => /999|50%|pill|destructive|error/.test(d.value))).toEqual([])
		const source = readFileSync(join(dir, 'composer.tsx'), 'utf8')
		expect(source).not.toContain('bg-destructive')
		expect(source).not.toContain('rounded-full')
	})

	it('draws Reject as a quiet answer, not an error', () => {
		const reject = all.filter(
			(d) =>
				d.file === 'composer-approval.css' && d.selector === '.approval-button[data-tone="reject"]',
		)
		expect(reject.filter((d) => /error/.test(d.value))).toEqual([])
	})
})
