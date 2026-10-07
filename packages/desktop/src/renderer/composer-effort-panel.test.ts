import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { ComposerEffortPanel } from './composer-effort-panel.js'

function render(overrides: Partial<Parameters<typeof ComposerEffortPanel>[0]> = {}) {
	return renderToStaticMarkup(
		createElement(ComposerEffortPanel, {
			scope: 'project:session:codex:gpt',
			modelLabel: 'GPT-5.6 Sol',
			levels: ['low', 'medium', 'high', 'xhigh', 'max'],
			value: 'xhigh',
			defaultValue: 'medium',
			loading: false,
			disabled: false,
			onChange: vi.fn(),
			onShowModels: vi.fn(),
			onUnavailable: vi.fn(),
			...overrides,
		}),
	)
}

it('shows the level in force, the model button and one stop per offered level', () => {
	const html = render()
	expect(html).toContain('>Extra High</output>')
	expect(html).toContain('GPT-5.6 Sol')
	expect(html).toContain(', change model')
	expect(html.match(/composer-effort-stop"/g)).toHaveLength(5)
	// Stops up to the thumb are drawn on the filled part of the track.
	expect(html.match(/data-passed/g)).toHaveLength(4)
	expect(html).toContain('Faster')
	expect(html).toContain('Smarter')
	expect(html).toContain('aria-valuetext="Extra High"')
	expect(html.match(/<input[^>]*type="range"[^>]*>/)?.[0]).toMatch(/max="4"/)
})

it('offers the reset only while the effort differs from the model default', () => {
	const reset = (html: string) =>
		html.match(/<button[^>]*aria-label="Use default effort"[^>]*>/)?.[0] ?? ''
	expect(reset(render())).not.toContain('disabled=""')
	expect(reset(render({ value: 'medium' }))).toContain('disabled=""')
	expect(reset(render({ defaultValue: undefined }))).toContain('disabled=""')
	expect(reset(render({ disabled: true }))).toContain('disabled=""')
})

it('waits for the levels instead of drawing an empty slider', () => {
	const html = render({ loading: true, levels: [], value: undefined })
	expect(html).toContain('Loading effort levels')
	expect(html).not.toContain('type="range"')
})

it('draws the slider unset, not on the first level, when no level is in force', () => {
	const html = render({ value: undefined, defaultValue: undefined })
	expect(html).toContain('>Model default</output>')
	expect(html).toContain('data-unset')
	expect(render()).not.toContain('data-unset')
})
