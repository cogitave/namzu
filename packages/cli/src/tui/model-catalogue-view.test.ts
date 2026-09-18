import { describe, expect, it } from 'vitest'
import { modelCatalogueView } from './model-catalogue-view.js'

it('keeps malformed or unfamiliar receipts on the ordinary output path', () => {
	for (const output of [
		'bad JSON',
		'{}',
		'{"models":[{}],"omitted":0}',
		'{"models":[],"omitted":-1}',
	])
		expect(modelCatalogueView(output)).toBeUndefined()
})
it('distinguishes empty results, unavailable catalogues and omitted matches', () => {
	expect(modelCatalogueView(JSON.stringify({ models: [], omitted: 0 }))).toContain(
		'No matching models',
	)
	expect(
		modelCatalogueView(
			JSON.stringify({
				models: [{ provider: 'zen', status: 'catalogue unavailable' }],
				omitted: 0,
			}),
		),
	).toContain('zen · catalogue unavailable')
	const models = Array.from({ length: 7 }, (_, index) => ({
		provider: 'zen',
		id: `id-${index}`,
		name: `Model ${index}`,
	}))
	const result = modelCatalogueView(JSON.stringify({ models, omitted: 3 }))
	expect(result).toContain('+5 more')
	expect(result).not.toContain('Model 5')
	expect(result).not.toContain('Effort')
})
it('distinguishes an unsupported effort menu from unknown metadata', () => {
	expect(
		modelCatalogueView(
			JSON.stringify({
				models: [{ provider: 'zen', id: 'id', name: 'Name', reasoningEffortLevels: [] }],
				omitted: 0,
			}),
		),
	).toContain('Effort not supported')
})

// Three answers, three renderings. The middle one is the fix: had absence been
// given the obvious rendering it would have printed `$0.00`, which is the same
// sentence as `Free` to a reader — and it is the sentence six drivers were
// manufacturing by writing `0` for a rate they never learned.
describe('what a model costs, and what it costs when nobody said', () => {
	const view = (model: Record<string, unknown>) =>
		modelCatalogueView(JSON.stringify({ models: [{ provider: 'zen', ...model }], omitted: 0 }))

	it('renders an absent rate as unknown rather than as zero', () => {
		expect(view({ id: 'id', name: 'Name' })).toContain('Price unknown')
		expect(view({ id: 'id', name: 'Name' })).not.toContain('$0')
		expect(view({ id: 'id', name: 'Name' })).not.toContain('Free')
	})

	it('renders a published rate as the rate', () => {
		expect(view({ id: 'id', name: 'Name', inputPrice: 3, outputPrice: 15 })).toContain(
			'$3/$15 per Mtok',
		)
	})

	it('renders a known zero as free, which is not the same answer', () => {
		const rendered = view({ id: 'id', name: 'Name', inputPrice: 0, outputPrice: 0 })

		expect(rendered).toContain('Free')
		expect(rendered).not.toContain('Price unknown')
	})

	it('refuses to call a half-known rate either one', () => {
		// One rate published and the other not is not a free model and not a
		// priced one. It is an incomplete answer, and says so.
		expect(view({ id: 'id', name: 'Name', inputPrice: 3 })).toContain('Price unknown')
		expect(view({ id: 'id', name: 'Name', inputPrice: 3 })).not.toContain('$3')
	})
})
