import { useSyncExternalStore } from 'react'
import { codeThemeIds } from '../shared/code-themes.js'
import type { DesktopSettings } from '../shared/settings-protocol.js'
import { APPEARANCE_PREFS_KEY } from './appearance-prefs.js'

/**
 * What the code views (a diff, a file, an approval card) and the terminal need from the code
 * settings that CSS cannot carry: the highlighter's theme for each appearance, and a change signal.
 * The font and size reach CSS through tokens on the root (appearance-prefs.ts); a terminal reads
 * those tokens when it is created and again on every change announced here.
 */
export interface CodePrefs {
	/** The highlighter's theme ids. */
	light: string
	dark: string
}

type Source = Pick<DesktopSettings, 'lightCodeTheme' | 'darkCodeTheme'>

export function codePrefsOf(source: Partial<Source>): CodePrefs {
	const { light, dark } = codeThemeIds(source.lightCodeTheme, source.darkCodeTheme)
	return { light, dark }
}

function fromMirror(): CodePrefs {
	try {
		return codePrefsOf(JSON.parse(localStorage.getItem(APPEARANCE_PREFS_KEY) ?? '{}'))
	} catch {
		return codePrefsOf({})
	}
}

let current: CodePrefs | undefined
const listeners = new Set<() => void>()

export function getCodePrefs(): CodePrefs {
	current ??= fromMirror()
	return current
}

/** Called after the root's tokens are set, so a listener that reads them sees the new values. */
export function setCodePrefs(source: Source): void {
	const next = codePrefsOf(source)
	const before = getCodePrefs()
	const changed = before.light !== next.light || before.dark !== next.dark
	if (changed) current = next
	// The font and size may have changed with the themes unchanged: always tell the listeners.
	for (const listener of [...listeners]) listener()
}

export function subscribeCodePrefs(listener: () => void): () => void {
	listeners.add(listener)
	return () => void listeners.delete(listener)
}

/** The highlighter themes for the current choices; the component redraws when they change. */
export function useCodePrefs(): CodePrefs {
	return useSyncExternalStore(subscribeCodePrefs, getCodePrefs, getCodePrefs)
}
