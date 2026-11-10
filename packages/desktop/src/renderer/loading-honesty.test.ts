import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')

/** Each loading placeholder, the sheet that styles it and the selector that must hold it back. */
const placeholders: [file: string, selector: string][] = [
	['restore-skeleton.css', '.restore-skeleton'],
	['pals-page.css', '.sidebar-skeleton'],
	['pals-page.css', '.pal-model-skeleton'],
	['pals-page.css', '.pal-loading'],
	['sidebar-navigation.css', '.sidebar-archive-placeholder::before'],
	['sidebar-section.css', '.sidebar-section-skeleton'],
	['model-picker.css', '.model-picker-trigger-skeleton'],
	['model-picker.css', '.model-picker-loading'],
]

/** The declarations of every rule whose selector list names `selector` exactly. */
function bodies(css: string, selector: string): string[] {
	const found: { selector: string; body: string; reduced: boolean }[] = []
	const reducedStart = (index: number) => {
		const before = css.slice(0, index)
		const open = before.lastIndexOf('@media (prefers-reduced-motion: reduce)')
		if (open < 0) return false
		const depth = (text: string) => text.split('{').length - text.split('}').length
		return depth(before.slice(open)) > 0
	}
	for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
		found.push({
			selector: (m[1] ?? '').trim().replace(/^\/\*[\s\S]*?\*\/\s*/, ''),
			body: m[2] ?? '',
			reduced: reducedStart(m.index ?? 0),
		})
	}
	return found
		.filter((r) => r.selector.split(/,\s*/).includes(selector))
		.map((r) => `${r.reduced ? 'reduced' : 'normal'}:${r.body}`)
}

describe('loading honesty', () => {
	const theme = read('theme.css')

	it('holds a placeholder for half a second, then fades it in over 150 ms', () => {
		expect(theme).toContain('--placeholder-delay: 500ms;')
		expect(theme).toContain('--placeholder-fade: 150ms;')
		expect(theme).toMatch(
			/--placeholder-reveal: placeholder-reveal var\(--placeholder-fade\) var\(--ease-out\)\s+var\(--placeholder-delay\) backwards;/,
		)
		// From transparent, no end frame: the placeholder settles on whatever its own animation says.
		expect(read('style.css')).toMatch(
			/@keyframes placeholder-reveal \{\s*from \{\s*opacity: 0;\s*\}\s*\}/,
		)
	})

	it.each(placeholders)(
		'%s %s waits and fades in, and keeps the wait without motion',
		(file, selector) => {
			const rules = bodies(read(file), selector)
			const normal = rules.filter((r) => r.startsWith('normal:')).join('\n')
			const reduced = rules.filter((r) => r.startsWith('reduced:')).join('\n')
			expect(normal).toContain('var(--placeholder-reveal)')
			// The reveal is last in the list, so it overrides a pulse during the wait.
			expect(normal).toMatch(/var\(--placeholder-reveal\);/)
			// The global reduced-motion rule says `animation: none !important`; this one has to out-rank it.
			expect(reduced).toContain('animation: var(--placeholder-reveal-still) !important;')
		},
	)

	it('the reduced reveal is still: a one-millisecond step after the same wait', () => {
		expect(theme).toMatch(
			/--placeholder-reveal-still: placeholder-reveal 1ms linear var\(--placeholder-delay\) backwards;/,
		)
	})
})
