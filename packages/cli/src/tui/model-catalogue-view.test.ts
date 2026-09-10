import { expect, it } from 'vitest'
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
