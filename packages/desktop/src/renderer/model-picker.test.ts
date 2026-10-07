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

it('names the Default row for assistive tools with the model it stands for, and keeps notes in model names', () => {
	catalogue('codex-cli', [
		{ id: 'gpt-top', label: 'GPT Top', default: true },
		{ id: 'gpt-other', label: 'GPT Other', note: 'Fast and cheap' },
	])
	const html = render({
		available: [{ id: 'codex-cli', label: 'Codex', defaultModel: 'gpt-top' }],
		selected: { id: 'codex-cli', model: 'gpt-top' },
	})
	expect(html).toContain('aria-label="Default, recommended: GPT Top"')
	expect(html).toContain('aria-label="Codex GPT Other Fast and cheap"')
})

it('falls back to the provider default model for the Default row when no row is flagged', () => {
	catalogue('sample', [
		{ id: 'sample-a', label: 'Sample A' },
		{ id: 'sample-b', label: 'Sample B' },
	])
	const html = render({
		available: [{ id: 'sample', label: 'Sample', defaultModel: 'sample-b' }],
		selected: { id: 'sample', model: 'sample-a' },
	})
	expect(html).toContain('Recommended · Sample B')
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

it('leads the list with a Default row naming the engine recommendation, checked only when it is the preset', () => {
	catalogue('codex-cli', [
		{ id: 'gpt-top', label: 'GPT Top', default: true },
		{ id: 'gpt-other', label: 'GPT Other' },
	])
	const providers: ProviderView = {
		available: [{ id: 'codex-cli', label: 'Codex', defaultModel: 'gpt-top' }],
		selected: { id: 'codex-cli', model: 'gpt-top' },
	}
	const row = (html: string, name: string) =>
		html.match(
			new RegExp(
				`<button[^>]*aria-label="${name === 'Default' ? 'Default, recommended: [^"]*' : name}"[^>]*>`,
			),
		)?.[0]
	const preset = render(providers, {
		choice: { provider: 'codex-cli', model: 'gpt-top', label: 'GPT Top', preset: 'default' },
	})
	expect(preset.indexOf('Recommended · GPT Top')).toBeGreaterThan(0)
	expect(preset.indexOf('aria-label="Default"')).toBeLessThan(
		preset.indexOf('aria-label="Codex GPT Top"'),
	)
	expect(row(preset, 'Default')).toContain('aria-checked="true"')
	expect(row(preset, 'Codex GPT Top')).toContain('aria-checked="false"')
	const explicit = render(providers, {
		choice: { provider: 'codex-cli', model: 'gpt-top', label: 'GPT Top' },
	})
	expect(row(explicit, 'Default')).toContain('aria-checked="false"')
	expect(row(explicit, 'Codex GPT Top')).toContain('aria-checked="true"')
	expect(explicit).toContain('Choose a model')
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

it('keeps the current model visible when it is not in the list', () => {
	catalogue('zen', [{ id: 'listed-model', label: 'Listed model' }])
	const html = render({
		available: [{ id: 'zen', label: 'Zen', defaultModel: 'unlisted-default' }],
		selected: { id: 'zen', model: 'actual-custom' },
	})
	expect(html).toContain('Current model')
	expect(html).toContain('actual-custom')
	expect(html).not.toContain('aria-label="Zen actual-custom"')
	expect(html.match(/role="radio"/g)).toHaveLength(1)
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
