import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	canListInstalledFonts,
	familyNamesOf,
	getInstalledFontsState,
	listInstalledFonts,
	loadInstalledFonts,
	resetInstalledFonts,
	subscribeInstalledFonts,
} from './installed-fonts.js'

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

describe('the list shared by every font row', () => {
	afterEach(() => resetInstalledFonts())

	it('loads once for all rows: every subscriber sees loading, then the same ready list', async () => {
		resetInstalledFonts()
		const view = { queryLocalFonts: vi.fn(async () => [{ family: 'Inter' }, { family: 'Arial' }]) }
		const first = vi.fn()
		const second = vi.fn()
		const stopFirst = subscribeInstalledFonts(first)
		const stopSecond = subscribeInstalledFonts(second)
		expect(getInstalledFontsState(view).status).toBe('idle')
		loadInstalledFonts(view)
		expect(getInstalledFontsState(view).status).toBe('loading')
		// A second ask while the first runs does nothing.
		loadInstalledFonts(view)
		await vi.waitFor(() => expect(getInstalledFontsState(view).status).toBe('ready'))
		expect(view.queryLocalFonts).toHaveBeenCalledTimes(1)
		expect(getInstalledFontsState(view)).toEqual({ status: 'ready', families: ['Arial', 'Inter'] })
		expect(first).toHaveBeenCalled()
		expect(second).toHaveBeenCalledTimes(first.mock.calls.length)
		// The snapshot is stable between reads.
		expect(getInstalledFontsState(view)).toBe(getInstalledFontsState(view))
		stopFirst()
		stopSecond()
	})

	it('shows a failure to every row', async () => {
		resetInstalledFonts()
		const view = {
			queryLocalFonts: async () => {
				throw new Error('refused')
			},
		}
		loadInstalledFonts(view)
		await vi.waitFor(() => expect(getInstalledFontsState(view).status).toBe('failed'))
	})

	it('is unavailable where the window cannot list', () => {
		resetInstalledFonts()
		expect(getInstalledFontsState({}).status).toBe('unavailable')
	})
})
