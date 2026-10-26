/**
 * Which theme is showing, and the way to change it while the TUI runs.
 *
 * Three inputs decide it: the saved setting (`auto` or a name), what `auto`
 * detected, and a preview (the picker's highlighted row, dropped when the
 * picker closes). Applying a change fills the live `theme` object and bumps an
 * epoch that `useThemeEpoch` subscribers redraw on, so a component that is
 * memoised still repaints.
 */

import { createContext, useContext, useSyncExternalStore } from 'react'

import { type Background, detectBackground } from './theme-detect.js'
import { type ThemeName, type ThemeSetting, resolveTheme } from './theme-palettes.js'
import { applyPalette } from './theme.js'

let saved: ThemeSetting = 'dark'
let reported: Background | undefined
let preview: ThemeSetting | undefined
let epoch = 0
const listeners = new Set<() => void>()
let current: ThemeName = 'dark'

function recompute(env: NodeJS.ProcessEnv): void {
	const shown = preview ?? saved
	const detected = shown === 'auto' ? detectBackground(reported, env) : undefined
	const next = resolveTheme(shown, detected)
	if (next === current) return
	current = next
	applyPalette(next)
	epoch += 1
	for (const listener of [...listeners]) listener()
}

/** Set the saved setting (and what `auto` has detected, if known). */
export function setThemeSetting(
	setting: ThemeSetting,
	options: { readonly reported?: Background; readonly env?: NodeJS.ProcessEnv } = {},
): void {
	saved = setting
	if (options.reported !== undefined) reported = options.reported
	recompute(options.env ?? process.env)
}

/** Show `setting` without saving it; `undefined` goes back to the saved one. */
export function setThemePreview(
	setting: ThemeSetting | undefined,
	env: NodeJS.ProcessEnv = process.env,
): void {
	preview = setting
	recompute(env)
}

/** The setting that is saved (not a preview). */
export function savedThemeSetting(): ThemeSetting {
	return saved
}

/** The theme on screen now. */
export function shownTheme(): ThemeName {
	return current
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

/**
 * The epoch the App last drew with, handed down so that a memoised row, which
 * skips a redraw when its props are unchanged, still repaints in new colours.
 * Subscribing in every row would put a listener on each of them.
 */
export const ThemeEpochContext = createContext(0)

/** Read inside a memoised component: it redraws when the shown theme changes. */
export function useThemeEpoch(): number {
	return useContext(ThemeEpochContext)
}

/** The App's own subscription: its redraw is what carries a new theme to the screen. */
export function useThemeSubscription(): number {
	return useSyncExternalStore(
		subscribe,
		() => epoch,
		() => epoch,
	)
}

/** For tests: back to the default with no listeners. */
export function resetThemeStore(): void {
	saved = 'dark'
	reported = undefined
	preview = undefined
	listeners.clear()
	current = 'dark'
	applyPalette('dark')
	epoch = 0
}
