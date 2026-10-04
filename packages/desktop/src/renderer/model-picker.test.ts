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
	expect(html).toContain('aria-label="Search models"')
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

it('keeps notices, actual model notes and manual IDs available in the compact menu', () => {
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
	expect(html).toContain('aria-label="Retry Zen models"')
	expect(html).toContain('Use a model ID…')
	expect(html).toContain('data-selected-model-icon="remote"')
})

it('places controlled effort beside the selected radio without nested buttons or profile-only effort', () => {
	const providers: ProviderView = {
		available: [{ id: 'codex-cli', label: 'Codex CLI', defaultModel: 'native-first' }],
		selected: { id: 'codex-cli', model: 'native-first' },
	}
	catalogue('codex-cli', [{ id: 'native-first', label: 'Native first' }])
	const html = render(providers, {
		settings: { effortLevels: ['low', 'high'], effortDefault: 'low' },
		effort: 'high',
		onEffortChange: vi.fn(),
	})
	expect(html.indexOf('aria-label="Reasoning effort"')).toBeGreaterThan(0)
	expect(html.indexOf('aria-label="Reasoning effort"')).toBeGreaterThan(
		html.indexOf('class="model-provider-single"'),
	)
	const selectedRadio = html.match(
		/<button[^>]*aria-label="Codex CLI Native first"[^>]*>[\s\S]*?<\/button>/,
	)?.[0]
	expect(selectedRadio).toContain('aria-checked="true"')
	expect(selectedRadio).not.toContain('aria-label="Reasoning effort"')
	expect(html.match(/<button[^>]*aria-label="Reasoning effort"/g)).toHaveLength(1)
	expect(html).not.toContain('model-picker-controls')
	expect(render(providers)).not.toContain('aria-label="Reasoning effort"')
	expect(render(providers, { settings: {}, onEffortChange: vi.fn() })).not.toContain(
		'aria-label="Reasoning effort"',
	)
})

it('retains effort for a real current model ID absent from the catalogue without adding a fake radio option', () => {
	catalogue('zen', [{ id: 'listed-model', label: 'Listed model' }])
	const html = render(
		{
			available: [{ id: 'zen', label: 'Zen', defaultModel: 'listed-model' }],
			selected: { id: 'zen', model: 'actual-custom' },
		},
		{
			settings: { effortLevels: ['low', 'high'], effortDefault: 'low' },
			onEffortChange: vi.fn(),
		},
	)
	expect(html).toContain('Current model')
	expect(html).toContain('actual-custom')
	expect(html).toContain('aria-label="Reasoning effort"')
	expect(html).not.toContain('aria-label="Zen actual-custom"')
	expect(html.match(/role="radio"/g)).toHaveLength(1)
})

it('keeps unavailable capability feedback inside the model picker and lets an obsolete effort be reset', () => {
	const html = render(
		{
			available: [{ id: 'zen', label: 'Zen', defaultModel: 'actual-model' }],
			selected: { id: 'zen', model: 'actual-model' },
		},
		{
			settings: { notice: 'Actual model settings unavailable.' },
			effort: 'max',
			onEffortChange: vi.fn(),
		},
	)
	expect(html).toContain('Actual model settings unavailable.')
	expect(html).toContain('aria-label="Reset reasoning effort"')
	expect(html).not.toContain('aria-label="Reasoning effort"')
})
