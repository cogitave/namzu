import { describe, expect, it } from 'vitest'
import type { Preferences } from '../integrations/providers/index.js'
import { choosesModel, launchPreferences } from './launch-settings.js'

const saved: Preferences = {
	version: 3,
	providers: [{ id: 'anthropic', model: 'a-1' }, { id: 'openai' }],
	subagents: { active: [] },
}

describe('launchPreferences', () => {
	it('--provider replaces the chain with that provider alone', () => {
		expect(launchPreferences(saved, { provider: 'zen', model: 'm' })?.providers).toEqual([
			{ id: 'zen', model: 'm' },
		])
		expect(launchPreferences(saved, { provider: 'zen' })?.providers).toEqual([{ id: 'zen' }])
	})

	it('--model alone re-models the saved primary and keeps the fallbacks', () => {
		expect(launchPreferences(saved, { model: 'b-2' })?.providers).toEqual([
			{ id: 'anthropic', model: 'b-2' },
			{ id: 'openai' },
		])
	})

	it('works with nothing saved when a provider is named', () => {
		expect(launchPreferences(null, { provider: 'zen', model: 'm' })?.providers).toEqual([
			{ id: 'zen', model: 'm' },
		])
	})

	it('cannot apply --model to nothing', () => {
		expect(launchPreferences(null, { model: 'm' })).toBeNull()
	})

	it('never mutates the saved preferences', () => {
		const before = JSON.stringify(saved)
		launchPreferences(saved, { provider: 'zen', model: 'm' })
		expect(JSON.stringify(saved)).toBe(before)
	})
})

describe('choosesModel', () => {
	it('is true only for a provider or a model', () => {
		expect(choosesModel(undefined)).toBe(false)
		expect(choosesModel({ effort: 'high', permissionMode: 'plan' })).toBe(false)
		expect(choosesModel({ model: 'm' })).toBe(true)
		expect(choosesModel({ provider: 'p' })).toBe(true)
	})
})
