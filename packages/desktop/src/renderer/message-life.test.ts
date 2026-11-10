import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
const footer = read('message-footer.css')
const rules = (css: string) =>
	[...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({
		selector: (m[1] ?? '').trim(),
		body: m[2] ?? '',
	}))

describe('message actions reveal', () => {
	const all = rules(footer)
	const rule = (selector: string) => all.find((r) => r.selector.endsWith(selector))

	it('waits a hover-intent beat to show, and leaves at once and fast', () => {
		expect(footer).toContain('--message-actions-delay: 100ms;')
		expect(rule('.message-footer')?.body).toMatch(
			/transition: opacity var\(--dur-instant\) var\(--ease-out\);/,
		)
		const hover = rule(
			'.message:hover > .message-footer,\n.pal-chat-message:hover > .message-footer',
		)
		expect(hover?.body).toMatch(
			/transition: opacity var\(--dur-quick\) var\(--ease-out\) var\(--message-actions-delay\);/,
		)
	})

	it('shows at once for keyboard focus and for a pressed or copying action', () => {
		const focus = all.find((r) => r.selector.includes(':focus-within'))
		expect(focus?.selector).toContain('[data-copy-state="copied"]')
		expect(focus?.body).toMatch(/transition: opacity var\(--dur-quick\) var\(--ease-out\);/)
		expect(focus?.body).not.toContain('--message-actions-delay')
	})

	it('has no fade and no wait under reduced motion, for every state that sets a transition', () => {
		const reduced = footer.slice(footer.indexOf('@media (prefers-reduced-motion: reduce)'))
		const covered = rules(reduced)[0]
		expect(covered?.body).toMatch(/transition: none;/)
		for (const state of ['.message:hover', '.message:focus-within', '.pal-chat-message:hover']) {
			expect(covered?.selector).toContain(state)
		}
	})

	it('keeps the touch rule: with no hover the row is simply visible', () => {
		expect(footer).toMatch(/@media \(hover: none\) \{\s*\.message-footer \{\s*opacity: 1;/)
	})
})

describe('the sent message settles with the scale', () => {
	it('names the overshoot duration and ease on the transcript', () => {
		const css = read('transcript-motion.css')
		expect(css).toContain('--transcript-pop-duration: var(--dur-slow);')
		expect(css).toContain('--transcript-pop-ease: var(--ease-pop);')
	})
})

describe('disclosure by grid rows', () => {
	const css = read('ui/collapsible.tsx')
	it('travels 0fr to 1fr on the base duration and stays hidden when closed', () => {
		expect(css).toContain('grid-rows-[1fr]')
		expect(css).toContain('data-starting-style:grid-rows-[0fr]')
		expect(css).toContain('data-ending-style:grid-rows-[0fr]')
		expect(css).toContain('duration-(--dur-base)')
		expect(css).toContain('[&[hidden]]:hidden')
		expect(css).toContain('motion-reduce:transition-none')
	})
	it('leaves the transcript disclosures on the measured-height path its proof owns', () => {
		for (const name of ['transcript.tsx', 'tool-transcript-row.tsx', 'plan-row-view.tsx']) {
			expect(read(name)).not.toMatch(/<CollapsiblePanel[^>]*\brows\b/)
		}
	})
})
