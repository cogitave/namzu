import { useCallback, useState } from 'react'
import { isSafeFontName } from '../shared/settings-catalogue.js'

/**
 * The fonts installed on this computer, read through the window's own font-listing call (the web
 * platform's `queryLocalFonts`, which Electron's engine provides on Windows, macOS and Linux). It
 * reads names only, downloads nothing, and needs a click: the engine refuses it otherwise. Where
 * the call is missing or refused the lists stay as they were: the two built-in choices.
 */
interface LocalFontData {
	family: string
}
interface FontWindow {
	queryLocalFonts?: () => Promise<LocalFontData[]>
}

/** Family names a stylesheet can carry safely, once each, sorted the way a person looks for them. */
export function familyNamesOf(fonts: readonly LocalFontData[]): string[] {
	const names = new Set<string>()
	for (const font of fonts) {
		const name = typeof font.family === 'string' ? font.family.trim() : ''
		if (isSafeFontName(name)) names.add(name)
	}
	return [...names].sort((left, right) =>
		left.localeCompare(right, undefined, { sensitivity: 'base' }),
	)
}

export type InstalledFontsState =
	| { status: 'idle' }
	| { status: 'loading' }
	| { status: 'ready'; families: readonly string[] }
	| { status: 'unavailable' }

let cached: readonly string[] | undefined

/** Whether this window can list fonts at all. */
export function canListInstalledFonts(view: FontWindow | undefined): boolean {
	return typeof view?.queryLocalFonts === 'function'
}

export async function listInstalledFonts(view: FontWindow | undefined): Promise<readonly string[]> {
	if (cached) return cached
	if (!view?.queryLocalFonts) throw new Error('This window cannot list fonts.')
	cached = familyNamesOf(await view.queryLocalFonts())
	return cached
}

/** The list, loaded when the person asks for it (the engine needs that click). */
export function useInstalledFonts(): [InstalledFontsState, () => void] {
	const view = typeof window === 'undefined' ? undefined : (window as FontWindow)
	const [state, setState] = useState<InstalledFontsState>(() =>
		cached
			? { status: 'ready', families: cached }
			: canListInstalledFonts(view)
				? { status: 'idle' }
				: { status: 'unavailable' },
	)
	const load = useCallback(() => {
		setState({ status: 'loading' })
		listInstalledFonts(view)
			.then((families) => setState({ status: 'ready', families }))
			.catch(() => setState({ status: 'unavailable' }))
	}, [view])
	return [state, load]
}
