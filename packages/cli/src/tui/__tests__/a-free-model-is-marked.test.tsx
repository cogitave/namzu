/** The marker only pays off if it reaches the screen. */

import { afterEach, expect, it, vi } from 'vitest'

import type { DetectedProvider } from '../../integrations/providers/index.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/registry.js'
import { Picker } from '../Picker.js'
import type { ModelListing } from '../agent.js'
import { type Screen, renderToScreen } from './support/screen.js'

// Real rows from https://openrouter.ai/api/v1/models (no key), taken on
// 2026-09-18, at the per-million-token prices `@namzu/openrouter` converts them
// to. Two are zero-priced and one of those spells it in neither its ID nor its
// display name, so the row can only be marked by what its price says.
const MODELS: ModelListing = {
	kind: 'ok',
	models: [
		{ id: 'unbiased/pareto', name: 'Pareto', inputPrice: 2.5, outputPrice: 7.5 },
		{
			id: 'google/lyria-3-pro-preview',
			name: 'Google: Lyria 3 Pro Preview',
			inputPrice: 0,
			outputPrice: 0,
		},
		{
			id: 'nex-agi/nex-n2.5-mini:free',
			name: 'Nex AGI: Nex-N2.5-Mini (free)',
			inputModalities: ['text', 'image'],
			inputPrice: 0,
			outputPrice: 0,
		},
	],
}

const detected: DetectedProvider[] = [
	{
		entry: { ...PROVIDER_REGISTRY.openrouter, defaultModel: 'unbiased/pareto' },
		source: { kind: 'env', envName: 'OPENROUTER_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]

let mounted: Screen | null = null

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

async function open(cols: number): Promise<Screen> {
	const screen = await renderToScreen(
		<Picker
			detected={detected}
			currentProvider="openrouter"
			initialView="models"
			describeModels={async () => MODELS}
			onSubmit={vi.fn()}
			onCancel={vi.fn()}
		/>,
		{ cols, rows: 16 },
	)
	mounted = screen
	await vi.waitFor(async () => {
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).toContain('Search:')
	})
	return screen
}

function rowWith(screen: Screen, text: string): string {
	const row = screen.viewport().find((line) => line.includes(text))
	expect(row, `no row contains ${text}`).toBeDefined()
	return row ?? ''
}

it('marks the zero-priced rows (free) and leaves the paid one unmarked', async () => {
	const screen = await open(100)
	const viewport = screen.viewport().join('\n')
	expect(viewport).toContain('(free)')

	// The strong one. Neither this row's ID nor its display name carries the
	// word, so `(free)` here can only have come from its price.
	expect(rowWith(screen, 'Lyria 3 Pro Preview')).toContain('(free)')
	// The word is in this model's own display name, so the marker beside it would
	// say it twice — and did, on 22 of the 25 zero-priced rows: this asserts the
	// capability note is still built and that `(free)` appears exactly once in
	// the row, where the name put it.
	expect(rowWith(screen, 'Nex-N2.5-Mini')).toContain('(image input)')
	expect(rowWith(screen, 'Nex-N2.5-Mini').split('(free)')).toHaveLength(2)
	expect(rowWith(screen, 'Pareto')).toContain('(namzu default)')
	expect(rowWith(screen, 'Pareto')).not.toContain('(free)')
})

it('keeps the marker on a narrow terminal, where notes are rebuilt from keywords', async () => {
	const screen = await open(40)
	// Under 70 columns the row's notes are not printed as written: the layout
	// rebuilds them from the words it recognises, and a word it does not know
	// is dropped. `(free)` is in that list, so it survives here too.
	expect(rowWith(screen, 'Lyria')).toContain('(free)')
	expect(rowWith(screen, 'Pareto')).not.toContain('(free)')
})
