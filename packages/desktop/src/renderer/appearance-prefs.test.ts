import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { DEFAULT_DESKTOP_SETTINGS } from '../shared/settings-protocol.js'
import {
	APPEARANCE_PREFS_KEY,
	type AppearancePrefs,
	PREF_ATTRIBUTES,
	RESPONSE_FONT_PROPERTY,
	applyAppearancePrefs,
	mirrorOf,
	responseFontStack,
	writePrefsMirror,
} from './appearance-prefs.js'
import { MOTION_EVENT, reducedMotion } from './motion-setting.js'
import { terminalFontFamily, terminalFontSize } from './terminal-theme.js'

function root() {
	const attributes = new Map<string, string>()
	const properties = new Map<string, string>()
	return {
		setAttribute: (name: string, value: string) => void attributes.set(name, value),
		removeAttribute: (name: string) => void attributes.delete(name),
		getAttribute: (name: string) => attributes.get(name) ?? null,
		style: {
			setProperty: (name: string, value: string) => void properties.set(name, value),
			removeProperty: (name: string) => void properties.delete(name),
		},
		classList: { toggle() {}, add() {} },
		attributes,
		properties,
	}
}

const defaults: AppearancePrefs = DEFAULT_DESKTOP_SETTINGS

describe('applying the appearance choices', () => {
	it('puts nothing on the root for the defaults', () => {
		const element = root()
		applyAppearancePrefs(element, defaults)
		expect(element.attributes.size).toBe(0)
		expect(element.properties.size).toBe(0)
	})

	it('sets one attribute per changed choice and removes it when it goes back', () => {
		const element = root()
		applyAppearancePrefs(element, {
			...defaults,
			transcriptTextSize: 'large',
			transcriptWidth: 'wide',
			motion: 'reduce',
			virtualizeConversations: false,
		})
		expect(element.attributes.get(PREF_ATTRIBUTES.textSize)).toBe('large')
		expect(element.attributes.get(PREF_ATTRIBUTES.width)).toBe('wide')
		expect(element.attributes.get(PREF_ATTRIBUTES.motion)).toBe('reduce')
		expect(element.attributes.get(PREF_ATTRIBUTES.virtualize)).toBe('off')
		applyAppearancePrefs(element, defaults)
		expect(element.attributes.size).toBe(0)
	})

	it('draws replies in a chosen font and stops when it is back on match', () => {
		const element = root()
		applyAppearancePrefs(element, { ...defaults, responseFont: 'family:Georgia' })
		expect(element.attributes.get(PREF_ATTRIBUTES.responseFont)).toBe('on')
		expect(element.properties.get(RESPONSE_FONT_PROPERTY)).toBe('"Georgia", var(--font-sans)')
		applyAppearancePrefs(element, defaults)
		expect(element.properties.has(RESPONSE_FONT_PROPERTY)).toBe(false)
	})

	it('names the two built-in stacks and refuses an unsafe name', () => {
		expect(responseFontStack('match')).toBeUndefined()
		expect(responseFontStack('app')).toBe('var(--font-sans-app)')
		expect(responseFontStack('system')).toBe('var(--font-sans-system)')
		expect(responseFontStack('a";}body{x:y')).toBeUndefined()
		expect(responseFontStack('family:a";}body{x:y')).toBeUndefined()
		// A font named like a built-in choice is stored under its prefix, so it stays distinct.
		expect(responseFontStack('family:System')).toBe('"System", var(--font-sans)')
		expect(responseFontStack('Georgia')).toBeUndefined()
	})

	it('keeps a copy for the first paint, without the choice that needs no first paint', () => {
		const writes = new Map<string, string>()
		writePrefsMirror({ setItem: (key, value) => void writes.set(key, value) }, defaults)
		expect(JSON.parse(writes.get(APPEARANCE_PREFS_KEY) ?? '{}')).toEqual(mirrorOf(defaults))
		expect(mirrorOf(defaults)).not.toHaveProperty('autoDismissPopups')
		expect(() =>
			writePrefsMirror(
				{
					setItem: () => {
						throw new Error('blocked')
					},
				},
				defaults,
			),
		).not.toThrow()
	})
})

/** Run public/theme-boot.js against a fake page whose storage holds `stored`. */
function boot(stored: Record<string, string>) {
	const element = root()
	runInNewContext(readFileSync(new URL('../../public/theme-boot.js', import.meta.url), 'utf8'), {
		localStorage: { getItem: (key: string) => stored[key] ?? null },
		window: { matchMedia: () => ({ matches: false }) },
		document: { documentElement: element },
	})
	return element
}

describe('the first paint (public/theme-boot.js)', () => {
	const changed: AppearancePrefs = {
		...defaults,
		transcriptTextSize: 'small',
		transcriptWidth: 'medium',
		motion: 'full',
		virtualizeConversations: false,
		responseFont: 'family:IBM Plex Sans',
	}

	it('sets exactly what applyAppearancePrefs sets from the mirror', () => {
		const expected = root()
		applyAppearancePrefs(expected, changed)
		const first = boot({ [APPEARANCE_PREFS_KEY]: JSON.stringify(mirrorOf(changed)) })
		expect(first.attributes).toEqual(expected.attributes)
		expect(first.properties).toEqual(expected.properties)
	})

	it('sets the built-in response stacks the same way', () => {
		for (const responseFont of ['app', 'system']) {
			const expected = root()
			applyAppearancePrefs(expected, { ...defaults, responseFont })
			const first = boot({
				[APPEARANCE_PREFS_KEY]: JSON.stringify(mirrorOf({ ...defaults, responseFont })),
			})
			expect(first.properties).toEqual(expected.properties)
		}
	})

	it('changes nothing with no mirror, a broken one or a hostile font name', () => {
		expect(boot({}).attributes.size).toBe(0)
		expect(boot({ [APPEARANCE_PREFS_KEY]: '{oops' }).attributes.size).toBe(0)
		const hostile = boot({ [APPEARANCE_PREFS_KEY]: JSON.stringify({ responseFont: 'a";}x{y' }) })
		expect(hostile.properties.size).toBe(0)
		expect(hostile.attributes.has(PREF_ATTRIBUTES.responseFont)).toBe(false)
	})

	it('draws an installed interface font before the first paint, and refuses a hostile one', () => {
		const set = boot({ 'namzu.interface-font': 'family:Source Sans 3' })
		expect(set.attributes.get('data-interface-font')).toBe('family:Source Sans 3')
		expect(set.properties.get('--font-sans')).toBe('"Source Sans 3", var(--font-sans-app)')
		expect(boot({ 'namzu.interface-font': 'family:a";}x' }).properties.size).toBe(0)
		expect(boot({ 'namzu.interface-font': 'system' }).attributes.get('data-interface-font')).toBe(
			'system',
		)
	})
})

describe('the code font and size', () => {
	const changed: AppearancePrefs = { ...defaults, codeFont: 'Fira Code', codeFontSize: 16 }

	it('sets the mono and terminal fonts and the code size on the root, and removes them at the defaults', () => {
		const element = root()
		applyAppearancePrefs(element, changed)
		const stack = '"Fira Code", var(--font-mono-app)'
		expect(element.properties.get('--font-mono')).toBe(stack)
		expect(element.properties.get('--font-terminal')).toBe(stack)
		expect(element.properties.get('--font-size-code')).toBe('16px')
		applyAppearancePrefs(element, defaults)
		expect(element.properties.size).toBe(0)
	})

	it('draws nothing for an unsafe font name', () => {
		const element = root()
		applyAppearancePrefs(element, { ...defaults, codeFont: 'a";}x{y' })
		expect(element.properties.size).toBe(0)
	})

	it('is drawn by the first paint exactly as applyAppearancePrefs draws it', () => {
		const expected = root()
		applyAppearancePrefs(expected, changed)
		const first = boot({ [APPEARANCE_PREFS_KEY]: JSON.stringify(mirrorOf(changed)) })
		expect(first.properties).toEqual(expected.properties)
	})

	it('first paint refuses a hostile name and a size outside the list', () => {
		const first = boot({
			[APPEARANCE_PREFS_KEY]: JSON.stringify({ codeFont: 'a";}x', codeFontSize: 99 }),
		})
		expect(first.properties.size).toBe(0)
		expect(
			boot({ [APPEARANCE_PREFS_KEY]: JSON.stringify({ codeFontSize: 13 }) }).properties.size,
		).toBe(0)
	})

	it('keeps the code choices in the mirror for the first paint', () => {
		expect(mirrorOf(changed)).toMatchObject({
			codeFont: 'Fira Code',
			codeFontSize: 16,
			lightCodeTheme: 'default',
			darkCodeTheme: 'default',
		})
	})

	it('reads the terminal size from the code size token, 13 with none', () => {
		const read = (value: string) => () => value
		expect(terminalFontSize(read('16px'))).toBe(16)
		expect(terminalFontSize(read(''))).toBe(13)
		expect(terminalFontSize(read('junk'))).toBe(13)
	})

	it('has the terminal read the code font token before its own default', () => {
		const stack = '"Fira Code", var(--font-mono-app)'
		expect(terminalFontFamily((name) => (name === '--font-terminal' ? stack : ''))).toBe(stack)
	})
})

describe('reduced motion for script', () => {
	const view = (attribute: string | null, device: boolean) => {
		const listeners = new Set<() => void>()
		return {
			matchMedia: () => ({ matches: device }),
			document: { documentElement: { getAttribute: () => attribute } },
			addEventListener: (type: string, listener: () => void) => {
				if (type === MOTION_EVENT) listeners.add(listener)
			},
			removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
			listeners,
		}
	}

	it('follows the device on System, and the choice otherwise', () => {
		expect(reducedMotion(view(null, true))?.matches).toBe(true)
		expect(reducedMotion(view(null, false))?.matches).toBe(false)
		expect(reducedMotion(view('reduce', false))?.matches).toBe(true)
		expect(reducedMotion(view('full', true))?.matches).toBe(false)
	})

	it('tells a listener when the choice changes and stops when removed', () => {
		const page = view('reduce', false)
		const media = reducedMotion(page)
		const listener = () => {}
		media?.addEventListener('change', listener)
		expect(page.listeners.has(listener)).toBe(true)
		media?.removeEventListener('change', listener)
		expect(page.listeners.size).toBe(0)
		expect(reducedMotion(undefined)).toBeUndefined()
	})
})

describe('the stylesheet', () => {
	const theme = readFileSync(new URL('./appearance-prefs.css', import.meta.url), 'utf8')
	const base = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
	const style = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
	const block = (selector: string) => {
		const start = theme.indexOf(selector)
		expect(start, selector).toBeGreaterThan(-1)
		return theme.slice(start, theme.indexOf('}', start))
	}

	it('sizes transcript text at 14, 15 (today) and 17 px on 20, 22 and 26 px lines', () => {
		expect(base).toMatch(/--text-reading: 15px;\s*--leading-reading: 22px;/)
		expect(block(':root[data-transcript-size="small"]')).toMatch(
			/--text-reading: 14px;\s*--leading-reading: 20px/,
		)
		expect(block(':root[data-transcript-size="large"]')).toMatch(
			/--text-reading: 17px;\s*--leading-reading: 26px/,
		)
	})

	it('widens the conversation and the composer together, and leaves narrow as today', () => {
		expect(base).toMatch(/--frame-column-width: 768px;/)
		expect(base).toMatch(/--turn-column-width: 736px;/)
		expect(block(':root[data-transcript-width="medium"]')).toMatch(
			/--frame-column-width: 896px;\s*--turn-column-width: 864px/,
		)
		expect(block(':root[data-transcript-width="wide"]')).toMatch(
			/--frame-column-width: 1024px;\s*--turn-column-width: 992px/,
		)
		expect(block(':root[data-transcript-width="wide"]')).toContain('--settings-column-width: 768px')
	})

	it('stops animation and transition under Reduce, and lets Full beat the device flag', () => {
		expect(block(':root[data-motion="reduce"],')).toMatch(/animation: none !important/)
		expect(block(':root[data-motion="reduce"],')).toMatch(/transition: none !important/)
		expect(style).toMatch(
			/prefers-reduced-motion: reduce\) \{\s*:root:not\(\[data-motion="full"\]\)/,
		)
	})

	it('gates every component-level reduced-motion rule on Motion not being Full', () => {
		const dir = dirname(fileURLToPath(import.meta.url))
		const ungated: string[] = []
		for (const name of readdirSync(dir).filter((n) => n.endsWith('.css'))) {
			const css = readFileSync(join(dir, name), 'utf8')
			for (const m of css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{/g)) {
				const rest = css.slice((m.index ?? 0) + m[0].length)
				if (!/^\s*:root:not\(\[data-motion="full"\]\)/.test(rest)) ungated.push(name)
			}
		}
		expect(ungated).toEqual([])
		const diff = readFileSync(join(dir, 'diff-theme.ts'), 'utf8')
		expect(diff).toContain(':host-context(:root:not([data-motion="full"])) [data-diff]')
	})

	it('draws off-screen turns and conversation rows when virtualizing is off', () => {
		expect(block(':root[data-virtualize="off"] .normal-transcript')).toContain(
			'content-visibility: visible',
		)
	})
})
