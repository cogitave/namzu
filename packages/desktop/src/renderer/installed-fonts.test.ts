import { describe, expect, it } from 'vitest'
import { canListInstalledFonts, familyNamesOf, listInstalledFonts } from './installed-fonts.js'

describe('the fonts installed on this computer', () => {
	it('lists each family once, sorted, and leaves out names a stylesheet could not carry', () => {
		expect(
			familyNamesOf([
				{ family: 'Zilla Slab' },
				{ family: 'arial' },
				{ family: 'Arial' },
				{ family: 'Bad"Name' },
				{ family: 'Zilla Slab' },
				{ family: '  Cantarell ' },
			]),
		).toEqual(['arial', 'Arial', 'Cantarell', 'Zilla Slab'])
	})

	it('is available only where the window has the listing call', () => {
		expect(canListInstalledFonts({})).toBe(false)
		expect(canListInstalledFonts(undefined)).toBe(false)
		expect(canListInstalledFonts({ queryLocalFonts: async () => [] })).toBe(true)
	})

	it('refuses when the window cannot list, and reads the names when it can', async () => {
		await expect(listInstalledFonts({})).rejects.toThrow('cannot list')
		await expect(
			listInstalledFonts({ queryLocalFonts: async () => [{ family: 'Inter' }] }),
		).resolves.toEqual(['Inter'])
	})
})
