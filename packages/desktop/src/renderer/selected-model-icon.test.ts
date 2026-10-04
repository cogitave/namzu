import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { SelectedModelIcon, selectedModelBrand } from './selected-model-icon.js'

it('uses the selected model identity across direct and gateway routes', () => {
	for (const [id, brand] of [
		['anthropic/claude-sonnet-4-5', 'anthropic'],
		['claude-opus-4-1', 'anthropic'],
		['openai/gpt-5.2', 'openai'],
		['gpt-5.3-codex', 'openai'],
		['o3-mini', 'openai'],
		['google/gemini-2.5-pro', 'google'],
		['gemini-3-flash-preview', 'google'],
		['deepseek/deepseek-chat', 'deepseek'],
		['deepseek-r1', 'deepseek'],
	] as const)
		expect(selectedModelBrand(id)).toBe(brand)
})

it('does not invent a manufacturer for opaque gateway or custom model IDs', () => {
	for (const id of [
		'',
		'space-bunny-free',
		'mimo-v2-flash',
		'my-claude-server',
		'custom-gpt-router',
		'qwen/qwen3',
	]) {
		expect(selectedModelBrand(id)).toBeUndefined()
		if (!id) expect(renderToStaticMarkup(createElement(SelectedModelIcon, { model: id }))).toBe('')
		else
			expect(
				renderToStaticMarkup(createElement(SelectedModelIcon, { model: id, provider: 'zen' })),
			).toContain('data-selected-model-icon="remote"')
	}
})

it('places the actual known mark in one decorative SVG without introducing a labelled control', () => {
	const html = renderToStaticMarkup(createElement(SelectedModelIcon, { model: 'gpt-5.3-codex' }))
	expect(html).toContain('data-selected-model-icon="openai"')
	expect(html).toContain('aria-hidden="true"')
	expect(html.match(/<svg\b/g)).toHaveLength(1)
	expect(html).not.toContain('button')
})

it('falls back to the actual provider or semantic route without inventing the model brand', () => {
	for (const [provider, identity] of [
		['codex', 'provider:openai'],
		['anthropic', 'provider:anthropic'],
		['ollama', 'local'],
		['lmstudio', 'local'],
		['zen', 'remote'],
		['openrouter', 'remote'],
	] as const) {
		const html = renderToStaticMarkup(
			createElement(SelectedModelIcon, { model: 'custom-model', provider }),
		)
		expect(html).toContain(`data-selected-model-icon="${identity}"`)
		expect(html.match(/<svg\b/g)).toHaveLength(1)
	}
	const known = renderToStaticMarkup(
		createElement(SelectedModelIcon, { model: 'claude-sonnet-4-5', provider: 'openai' }),
	)
	expect(known).toContain('data-selected-model-icon="anthropic"')
	expect(known).not.toContain('provider:openai')
	for (const provider of ['zen', 'openai', 'ollama'])
		expect(renderToStaticMarkup(createElement(SelectedModelIcon, { model: ' ', provider }))).toBe(
			'',
		)
})
