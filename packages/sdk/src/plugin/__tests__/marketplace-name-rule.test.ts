import { describe, expect, it } from 'vitest'

import {
	COMMON_MARKETPLACE_DIR,
	COMMON_MARKETPLACE_FILE,
	isOfficialLookingMarketplaceName,
} from '../index.js'

describe('the official-looking marketplace name rule', () => {
	it('names the folder and file a marketplace catalog sits in', () => {
		expect(`${COMMON_MARKETPLACE_DIR}/${COMMON_MARKETPLACE_FILE}`).toMatch(/\/marketplace\.json$/)
	})

	it('refuses the official catalogs and names built from the maker words', () => {
		expect(isOfficialLookingMarketplaceName('healthcare')).toBe(true)
		expect(isOfficialLookingMarketplaceName('Agent-Skills')).toBe(true)
		expect(isOfficialLookingMarketplaceName('claude-tools')).toBe(true)
		expect(isOfficialLookingMarketplaceName('team.anthropic')).toBe(true)
		expect(isOfficialLookingMarketplaceName('anthropic')).toBe(true)
	})

	it('lets an ordinary name through', () => {
		expect(isOfficialLookingMarketplaceName('team-tools')).toBe(false)
		expect(isOfficialLookingMarketplaceName('claudette')).toBe(false)
		expect(isOfficialLookingMarketplaceName('my-local')).toBe(false)
	})
})
