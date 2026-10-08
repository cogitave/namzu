import { type ComponentProps, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ModelCatalogueView, ProviderView } from '../shared/protocol.js'
import { ModelPicker } from './model-picker.js'

const ready = vi.hoisted(() => ({
	catalogues: {} as Record<string, { loading: false; value: ModelCatalogueView }>,
}))
vi.mock('react', async (original) => {
	const actual = await original<typeof import('react')>()
	return {
		...actual,
		useState(initial: unknown) {
			return actual.useState(
				initial && typeof initial === 'object' && Object.keys(initial).length === 0
					? ready.catalogues
					: initial,
			)
		},
	}
})
// Only portal materialization is substituted. The actual Base UI radio/tabs
// render their selection and accessible identities; native checks cover focus.
vi.mock('./ui/popover.js', async (original) => {
	const actual = await original<typeof import('./ui/popover.js')>()
	return {
		...actual,
		PopoverPopup: ({ children, ...props }: ComponentProps<typeof actual.PopoverPopup>) =>
			createElement('div', { 'aria-label': props['aria-label'] }, children),
	}
})

beforeEach(() => {
	ready.catalogues = {}
})
function render(
	providers: ProviderView,
	overrides: Partial<ComponentProps<typeof ModelPicker>> = {},
) {
	return renderToStaticMarkup(
		createElement(ModelPicker, {
			providers,
			choice: {
				provider: providers.selected?.id ?? '',
				model: providers.selected?.model ?? '',
			},
			disabled: false,
			projectId: 'ordinary',
			sessionId: 'owned',
			onChange: vi.fn(),
			...overrides,
		}),
	)
}
function catalogue(id: string, models: ModelCatalogueView['models'], notice: string | null = null) {
	ready.catalogues[id] = { loading: false, value: { models, notice } }
}

it('keeps a single native catalogue a plain, checked model list without redundant provider navigation', () => {
	catalogue('codex-cli', [
		{ id: 'native-first', label: 'Native first' },
		{ id: 'native-current', label: 'Native selected' },
	])
	const html = render({
		available: [{ id: 'codex-cli', label: 'Codex CLI', defaultModel: 'native-first' }],
		selected: { id: 'codex-cli', model: 'native-current' },
	})
	expect(html).toContain('class="model-provider-single"')
	expect(html).not.toContain('role="tablist"')
	expect(html).toContain('aria-label="Codex CLI models"')
	expect(html).toContain('aria-label="Codex CLI Native first"')
	expect(html).toContain('aria-label="Codex CLI Native selected"')
	const selected = html.match(/<button[^>]*aria-label="Codex CLI Native selected"[^>]*>/)?.[0]
	expect(selected).toContain('aria-checked="true"')
	// A short single-engine list carries no search control.
	expect(html).not.toContain('aria-label="Search models"')
	expect(html).not.toContain('Use a model ID…')
	expect(html).not.toContain('Quick search')
	expect(html).not.toContain('Recommended set of models')
})

it('retains actual provider navigation and the exact selected provider/model when catalogues share IDs', () => {
	catalogue('first', [{ id: 'shared', label: 'First model' }])
	catalogue('second', [{ id: 'shared', label: 'Second model' }])
	const html = render({
		available: [
			{ id: 'first', label: 'First provider', defaultModel: 'shared' },
			{ id: 'second', label: 'Second provider', defaultModel: 'shared' },
		],
		selected: { id: 'second', model: 'shared' },
	})
	expect(html).toContain('role="tablist"')
	expect(html).toContain('aria-label="Model providers"')
	expect(html).toContain('aria-label="First provider"')
	expect(html).toContain('aria-label="Second provider"')
	expect(html).toContain('aria-label="Second provider Second model"')
	expect(html).not.toContain('aria-label="First provider First model"')
	expect(html.match(/<button[^>]*aria-label="Second provider Second model"[^>]*>/)?.[0]).toContain(
		'aria-checked="true"',
	)
})

it('keeps notices and actual model notes in the compact menu, with no Retry button', () => {
	catalogue(
		'zen',
		[{ id: 'opaque-free', label: 'Opaque free', note: 'Actual catalogue note' }],
		'Actual catalogue warning',
	)
	const html = render({
		available: [{ id: 'zen', label: 'Zen', defaultModel: 'opaque-free' }],
		selected: { id: 'zen', model: 'opaque-free' },
	})
	expect(html).toContain('Actual catalogue note')
	expect(html).toContain('Actual catalogue warning')
	expect(html).not.toContain('Retry')
	expect(html).not.toContain('data-selected-model-icon')
})

it('offers search once a single-engine list grows long, and never refresh or typed model ids', () => {
	catalogue(
		'codex-cli',
		Array.from({ length: 13 }, (_, index) => ({ id: `m-${index}`, label: `Model ${index}` })),
	)
	const html = render({
		available: [{ id: 'codex-cli', label: 'Codex', defaultModel: 'm-0' }],
		selected: { id: 'codex-cli', model: 'm-1' },
	})
	expect(html).toContain('aria-label="Search models"')
	expect(html).not.toContain('Refresh')
	expect(html).not.toContain('Use a model ID')
	expect(html).not.toContain('Retry')
})

it('names the recommended row for assistive tools, and keeps notes in model names', () => {
	catalogue('codex-cli', [
		{ id: 'gpt-top', label: 'GPT Top', default: true },
		{ id: 'gpt-other', label: 'GPT Other', note: 'Fast and cheap' },
	])
	const html = render({
		available: [{ id: 'codex-cli', label: 'Codex', defaultModel: 'gpt-top' }],
		selected: { id: 'codex-cli', model: 'gpt-top' },
	})
	expect(html).toContain('aria-label="Codex GPT Top Recommended"')
	expect(html).toContain('aria-label="Codex GPT Other Fast and cheap"')
	expect(html).not.toContain('aria-label="Default')
})

it('does not recommend a model only because the provider names it', () => {
	catalogue('sample', [
		{ id: 'sample-a', label: 'Sample A' },
		{ id: 'sample-b', label: 'Sample B' },
	])
	const html = render({
		available: [{ id: 'sample', label: 'Sample', defaultModel: 'sample-b' }],
		selected: { id: 'sample', model: 'sample-a' },
	})
	expect(html).not.toContain('Recommended')
})

it('shows the catalogue name and the effort in the trigger, and names both for assistive tools', () => {
	catalogue('codex-cli', [{ id: 'gpt-x', label: 'GPT X' }])
	const html = render(
		{
			available: [{ id: 'codex-cli', label: 'Codex', defaultModel: 'gpt-x' }],
			selected: { id: 'codex-cli', model: 'gpt-x' },
		},
		{
			choice: { provider: 'codex-cli', model: 'gpt-x', label: 'Old saved name' },
			settings: { effortLevels: ['low', 'medium', 'xhigh'], effortDefault: 'medium' },
			effort: 'xhigh',
			onEffortChange: vi.fn(),
		},
	)
	const trigger = html.match(
		/<button[^>]*class="[^"]*model-picker-trigger[^"]*"[^>]*>[\s\S]*?<\/button>/,
	)?.[0]
	expect(trigger).toContain('aria-label="Model: Old saved name, effort: Extra High"')
	expect(trigger).toContain('model-picker-trigger-effort')
	expect(trigger).not.toContain('data-selected-model-icon')
})

it('shows the effort for an engine row that reports levels but no default', () => {
	catalogue('claude-code', [{ id: 'opus', label: 'Opus 5.5', current: true }])
	const providers: ProviderView = {
		available: [{ id: 'claude-code', label: 'Claude Code', defaultModel: 'opus' }],
		selected: { id: 'claude-code', model: 'opus' },
	}
	const withLevels = render(providers, {
		settings: { effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
		effort: 'high',
		onEffortChange: vi.fn(),
	})
	expect(withLevels).toContain('effort: High')
	expect(withLevels).toContain('model-picker-trigger-effort')
	// Without reported levels the trigger names the model only.
	const without = render(providers, { settings: {}, onEffortChange: vi.fn() })
	expect(without).not.toContain('model-picker-trigger-effort')
})

it('shows the model default effort when none is saved, and no effort when the model offers none', () => {
	const providers: ProviderView = {
		available: [{ id: 'codex-cli', label: 'Codex', defaultModel: 'gpt-x' }],
		selected: { id: 'codex-cli', model: 'gpt-x' },
	}
	expect(
		render(providers, {
			settings: { effortLevels: ['low', 'medium'], effortDefault: 'medium' },
			onEffortChange: vi.fn(),
		}),
	).toContain('aria-label="Model: gpt-x, effort: Medium"')
	const none = render(providers, { settings: {}, onEffortChange: vi.fn() })
	expect(none).toContain('aria-label="Model: gpt-x"')
	expect(none).not.toContain('model-picker-trigger-effort')
	// A saved effort the model does not offer is not shown.
	expect(
		render(providers, {
			settings: { effortLevels: ['low', 'medium'], effortDefault: 'medium' },
			effort: 'max',
			onEffortChange: vi.fn(),
		}),
	).toContain('aria-label="Model: gpt-x, effort: Medium"')
})

it('has no Default row: a recommended model is a chip on its own row, and an old preset is an ordinary choice', () => {
	catalogue('codex-cli', [
		{ id: 'gpt-top', label: 'GPT Top', default: true },
		{ id: 'gpt-other', label: 'GPT Other' },
	])
	const providers: ProviderView = {
		available: [{ id: 'codex-cli', label: 'Codex', defaultModel: 'gpt-top' }],
		selected: { id: 'codex-cli', model: 'gpt-top' },
	}
	const row = (html: string, name: string) =>
		html.match(new RegExp(`<button[^>]*aria-label="${name}"[^>]*>`))?.[0]
	const html = render(providers, {
		choice: { provider: 'codex-cli', model: 'gpt-top', label: 'GPT Top', preset: 'default' },
	})
	expect(html).not.toContain('Default')
	expect(html).toContain('model-picker-chip')
	expect(row(html, 'Codex GPT Top Recommended')).toContain('aria-checked="true"')
	expect(row(html, 'Codex GPT Other')).toContain('aria-checked="false"')
	expect(html.match(/role="radio"/g)).toHaveLength(2)
})

const longList = [
	{ id: 'm-6-1', label: 'Gamma 6.1' },
	{ id: 'm-6-0', label: 'Delta 6' },
	{ id: 'e-6', label: 'Epsilon 6' },
	{ id: 'g-5-9', label: 'Gamma 5.9' },
	{ id: 'd-5', label: 'Delta 5' },
	{ id: 'e-5', label: 'Epsilon 5' },
	{ id: 'g-5', label: 'Gamma 5' },
	{ id: 'd-4', label: 'Delta 4' },
]
const longProviders: ProviderView = {
	available: [{ id: 'long', label: 'Long', defaultModel: 'm-6-1' }],
	selected: { id: 'long', model: 'm-6-1' },
}

it('folds older models behind one collapsed row and counts them', () => {
	catalogue('long', longList)
	const html = render(longProviders)
	expect(html.match(/role="radio"/g)).toHaveLength(3)
	expect(html).toContain('Older models (5)')
	expect(html).toContain('aria-expanded="false"')
	// Eight rows pass the search threshold.
	expect(html).toContain('aria-label="Search models"')
})

it('keeps a checked older model visible, pinned under the current rows', () => {
	catalogue('long', longList)
	const html = render(longProviders, { choice: { provider: 'long', model: 'g-5-9' } })
	expect(html.match(/role="radio"/g)).toHaveLength(4)
	expect(html).toContain('Older models (4)')
	expect(html.indexOf('Gamma 5.9')).toBeGreaterThan(html.indexOf('Epsilon 6'))
	expect(html).toMatch(
		/aria-checked="true"[^>]*aria-label="Long Gamma 5.9"|aria-label="Long Gamma 5.9"[^>]*aria-checked="true"/,
	)
})

it('shows a short list whole with no fold and no search icon', () => {
	catalogue('long', longList.slice(0, 5))
	const html = render(longProviders)
	expect(html.match(/role="radio"/g)).toHaveLength(5)
	expect(html).not.toContain('Older models')
	expect(html).not.toContain('aria-label="Search models"')
})

it('offers no Default row when the engine marks no default model', () => {
	catalogue('codex-cli', [{ id: 'gpt-top', label: 'GPT Top' }])
	const html = render({
		available: [{ id: 'codex-cli', label: 'Codex', defaultModel: 'unlisted-default' }],
		selected: { id: 'codex-cli', model: 'gpt-top' },
	})
	expect(html).not.toContain('aria-label="Default')
	expect(html).not.toContain('Recommended')
})

it('shows no separate current-model section when the model is not in the list', () => {
	catalogue('zen', [{ id: 'listed-model', label: 'Listed model' }])
	const html = render({
		available: [{ id: 'zen', label: 'Zen', defaultModel: 'unlisted-default' }],
		selected: { id: 'zen', model: 'actual-custom' },
	})
	expect(html).not.toContain('Current model')
	expect(html).toContain('aria-label="Model: actual-custom"')
	expect(html).not.toContain('aria-label="Zen actual-custom"')
	expect(html.match(/role="radio"/g)).toHaveLength(1)
})

it('marks the provider in use on its tab', () => {
	catalogue('zen', [{ id: 'listed-model', label: 'Listed model' }])
	catalogue('codex-cli', [{ id: 'gpt-top', label: 'GPT Top' }])
	const html = render({
		available: [
			{ id: 'zen', label: 'Zen', defaultModel: 'listed-model' },
			{ id: 'codex-cli', label: 'Codex', defaultModel: 'gpt-top' },
		],
		selected: { id: 'codex-cli', model: 'gpt-top' },
	})
	expect(html.match(/data-in-use/g)).toHaveLength(1)
	expect(html).toMatch(/aria-label="Codex"[^>]*data-in-use|data-in-use[^>]*aria-label="Codex"/)
})

it('keeps capability feedback inside the model list', () => {
	const html = render(
		{
			available: [{ id: 'zen', label: 'Zen', defaultModel: 'actual-model' }],
			selected: { id: 'zen', model: 'actual-model' },
		},
		{ settings: { notice: 'Actual model settings unavailable.' }, onEffortChange: vi.fn() },
	)
	expect(html).toContain('Actual model settings unavailable.')
	expect(html).toContain('aria-label="Model: actual-model"')
})

const zenRows: ModelCatalogueView['models'] = [
	{ id: 'free-a', label: 'Free A', group: 'free' },
	{ id: 'free-b', label: 'Free B', group: 'free' },
	{ id: 'key-a', label: 'Key A', group: 'key', note: '(Limits not published yet)' },
	{ id: 'plain', label: 'Plain' },
]
const zenProviders: ProviderView = {
	available: [{ id: 'zen', label: 'Zen', defaultModel: 'free-a' }],
	selected: { id: 'zen', model: 'free-a' },
}

it('draws a heading before each Zen group, hidden from assistive tools and never a radio', () => {
	catalogue('zen', zenRows)
	const html = render(zenProviders)
	const headings = [
		...html.matchAll(/<div class="model-picker-group-title" aria-hidden="true">([^<]*)</g),
	]
	expect(headings.map((m) => m[1])).toEqual(['Free', 'API key', 'Other models'])
	// Order on screen: heading, then its rows.
	const at = (text: string) => html.indexOf(text)
	const title = (text: string) => at(`aria-hidden="true">${text}<`)
	expect(title('Free')).toBeLessThan(at('<span title="Free A'))
	expect(at('<span title="Free B')).toBeLessThan(title('API key'))
	expect(title('API key')).toBeLessThan(at('<span title="Key A'))
	expect(at('<span title="Key A')).toBeLessThan(title('Other models'))
	// The heading is still spoken, as part of each row's name; the limits note stays.
	expect(html).toContain('aria-label="Zen Free Free A"')
	expect(html).toContain('aria-label="Zen API key Key A (Limits not published yet)"')
	expect(html).toContain('Limits not published yet')
	expect(html).not.toContain('(API key)')
})

it('draws no heading for a Zen list with only free models, or for any other provider', () => {
	catalogue('zen', zenRows.slice(0, 2))
	const free = render(zenProviders)
	expect(free).not.toContain('model-picker-group-title')
	expect(free).toContain('aria-label="Zen Free A"')
	catalogue('zen', zenRows.slice(2, 3))
	expect(render(zenProviders)).not.toContain('model-picker-group-title')
})
