import { useCallback, useSyncExternalStore } from 'react'
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
	/** The list was asked for and the engine refused or failed. */
	| { status: 'failed' }

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

const IDLE: InstalledFontsState = { status: 'idle' }
const UNAVAILABLE: InstalledFontsState = { status: 'unavailable' }

// One list for the whole window: loading it in one font row fills every row, and a failure shows in all.
let shared: InstalledFontsState | undefined
const listeners = new Set<() => void>()

function windowView(): FontWindow | undefined {
	return typeof window === 'undefined' ? undefined : (window as FontWindow)
}

export function getInstalledFontsState(
	view: FontWindow | undefined = windowView(),
): InstalledFontsState {
	if (shared) return shared
	if (cached) {
		shared = { status: 'ready', families: cached }
		return shared
	}
	return canListInstalledFonts(view) ? IDLE : UNAVAILABLE
}

function publish(next: InstalledFontsState): void {
	shared = next
	for (const listener of [...listeners]) listener()
}

export function subscribeInstalledFonts(listener: () => void): () => void {
	listeners.add(listener)
	return () => void listeners.delete(listener)
}

/** Asks for the list (the engine needs a click for it); a second ask while one is running does nothing. */
export function loadInstalledFonts(view: FontWindow | undefined = windowView()): void {
	if (getInstalledFontsState(view).status === 'loading') return
	publish({ status: 'loading' })
	listInstalledFonts(view).then(
		(families) => publish({ status: 'ready', families }),
		() => publish({ status: 'failed' }),
	)
}

/** For tests: forget the list and the state. */
export function resetInstalledFonts(): void {
	cached = undefined
	shared = undefined
	for (const listener of [...listeners]) listener()
}

/** The shared list and the call that loads it; every font row sees the same state. */
export function useInstalledFonts(): [InstalledFontsState, () => void] {
	const state = useSyncExternalStore(
		subscribeInstalledFonts,
		getInstalledFontsState,
		() => UNAVAILABLE,
	)
	const load = useCallback(() => loadInstalledFonts(), [])
	return [state, load]
}
