import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import {
	ComposerEffortPanel,
	defaultStop,
	effortScale,
	effortValueText,
} from './composer-effort-panel.js'

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
	// Every stop of a short scale is named, and the one in force is marked.
	for (const name of ['Low', 'Medium', 'High', 'Extra High', 'Max'])
		expect(html).toContain(`>${name}</span>`)
	expect(html).toMatch(/data-current="true"[^>]*>Extra High<\/span>/)
	expect(html).toContain('aria-valuetext="Extra High"')
	expect(html.match(/<input[^>]*type="range"[^>]*>/)?.[0]).toMatch(/max="4"/)
})

it('has no reset icon, and marks the default stop instead', () => {
	const html = render()
	expect(html).not.toContain('Use default effort')
	expect(html.match(/data-default/g)).toHaveLength(1)
	expect(html).toContain('aria-valuetext="Extra High"')
	expect(render({ defaultValue: undefined })).not.toContain('data-default')
})

it('left-aligns the title and puts the engine chip on the right', () => {
	const html = render({
		engine: { id: 'codex-cli', label: 'Codex CLI', disabled: false, onOpen: vi.fn() },
	})
	expect(html).toContain('aria-label="Engine: Codex CLI"')
	expect(html.indexOf('composer-effort-title')).toBeLessThan(html.indexOf('Engine: Codex CLI'))
	expect(render()).not.toContain('Engine:')
})

const levels = ['low', 'medium', 'high'] as const
it('finds the default stop among the offered levels', () => {
	expect(defaultStop(levels, 'medium')).toBe(1)
	expect(defaultStop(levels, undefined)).toBe(-1)
	expect(defaultStop(levels, 'max')).toBe(-1)
})

it('says "(default)" only at the default stop', () => {
	expect(effortValueText(levels, 1, 'medium', 'Model default')).toBe('Medium (default)')
	expect(effortValueText(levels, 0, 'medium', 'Model default')).toBe('Low')
	expect(effortValueText(levels, 1, undefined, 'Model default')).toBe('Medium')
	expect(effortValueText(levels, 5, 'medium', 'Model default')).toBe('Model default')
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

it('names the ends and the stop in force on a long scale, never the end next to it', () => {
	const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
	expect(effortScale(levels, 3).map((item) => item.text)).toEqual(['None', 'Medium', 'Ultra'])
	// An end beside the current stop would run into its name.
	expect(effortScale(levels, 1).map((item) => item.text)).toEqual(['Minimal', 'Ultra'])
	expect(effortScale(['low', 'high'], 0).map((item) => [item.text, item.at])).toEqual([
		['Low', 0],
		['High', 100],
	])
})

it('offers hypermode as a switch under the slider, at any level, only where the composer offers it', () => {
	expect(render()).not.toContain('Hypermode')
	const on = render({ hypermode: { on: true, onChange: vi.fn() } })
	expect(on).toContain('Hypermode')
	expect(on).toMatch(
		/role="switch"[^>]*aria-label="Hypermode"[^>]*checked=""|checked=""[^>]*role="switch"/,
	)
	const off = render({ value: 'low', hypermode: { on: false, onChange: vi.fn() } })
	expect(off).toContain('role="switch"')
	expect(off).toContain('aria-checked="false"')
})

it('says why the switch cannot be turned on while dynamic workflows are off', () => {
	const sentence =
		'Hypermode needs dynamic workflows, and they are off. Turn them on in Settings (Dynamic workflows) first.'
	const html = render({ hypermode: { on: false, onChange: vi.fn(), blocked: sentence } })
	expect(html).toContain('Turn them on in Settings')
	expect(html.match(/<input[^>]*aria-label="Hypermode"[^>]*>/)?.[0]).toContain('disabled')
})

it('ties the help sentence to the switch for assistive technology', () => {
	const html = render({ hypermode: { on: false, onChange: vi.fn(), blocked: 'Because.' } })
	const id = html.match(/aria-describedby="([^"]+)"/)?.[1]
	expect(id).toBeTruthy()
	expect(html).toContain(`id="${id}">Because.`)
})

it('shows a stored yes as off while blocked, and a click clears it', () => {
	const onChange = vi.fn()
	const html = render({ hypermode: { on: true, onChange, blocked: 'No.' } })
	const input = html.match(/<input[^>]*aria-label="Hypermode"[^>]*>/)?.[0] ?? ''
	expect(input).toContain('aria-checked="false"')
	expect(input).not.toContain('disabled')
})

it('offers the mode on a model with no choice of effort', () => {
	const html = render({
		variant: 'inline',
		levels: ['medium'],
		hypermode: { on: false, onChange: vi.fn() },
	})
	expect(html).toContain('role="switch"')
	expect(html).not.toContain('type="range"')
	expect(render({ variant: 'inline', levels: ['medium'] })).toBe('')
})
