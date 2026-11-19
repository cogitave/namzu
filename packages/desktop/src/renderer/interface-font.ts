import { useSyncExternalStore } from 'react'
import {
	type CatalogueOption,
	catalogueEntry,
	isSafeFontName,
} from '../shared/settings-catalogue.js'
import { familyStack } from './appearance-prefs.js'

/**
 * The interface font: Namzu's own typeface (the default) or the one the device draws with. It is a
 * cosmetic choice of this window, so it lives in the renderer's own storage beside the theme, and it
 * is one attribute on the root: theme.css points the two font tokens at the platform stacks when
 * the attribute says `system`. A font installed on this computer is stored as `family:<name>`; the
 * attribute then carries the same text and the root's `--font-sans` is set to that family with the
 * app's face behind it. public/theme-boot.js sets the same things before the first paint.
 */
export type InterfaceFont = 'app' | 'system' | `family:${string}`

export const FAMILY_PREFIX = 'family:'

/** The font name inside a `family:` choice, or undefined for the two built-in choices. */
export function familyOf(value: InterfaceFont): string | undefined {
	return value.startsWith(FAMILY_PREFIX) ? value.slice(FAMILY_PREFIX.length) : undefined
}

export const INTERFACE_FONT_KEY = 'namzu.interface-font'
export const INTERFACE_FONT_ATTRIBUTE = 'data-interface-font'

export const INTERFACE_FONT_CHOICES: { value: InterfaceFont; label: string; hint: string }[] = (
	catalogueEntry('interface-font').control as { options: readonly CatalogueOption[] }
).options.map((option) => ({
	value: option.value as InterfaceFont,
	label: option.label,
	hint: option.help ?? '',
}))

/** A stored value as a choice; anything else is the default. */
export function parseInterfaceFont(value: unknown): InterfaceFont {
	if (value === 'system') return 'system'
	if (typeof value === 'string' && value.startsWith(FAMILY_PREFIX)) {
		const name = value.slice(FAMILY_PREFIX.length).trim()
		if (isSafeFontName(name)) return `${FAMILY_PREFIX}${name}`
	}
	return 'app'
}

/** The slice of an element the attribute needs, so a test can pass a plain object. */
export interface FontRoot {
	setAttribute(name: string, value: string): void
	removeAttribute(name: string): void
	getAttribute(name: string): string | null
	style?: { setProperty(name: string, value: string): void; removeProperty(name: string): void }
}

/** Put a choice on the root: `system` sets the attribute, the default removes it. */
export function applyInterfaceFont(root: FontRoot, value: InterfaceFont): void {
	const family = familyOf(value)
	if (value === 'system' || family !== undefined) root.setAttribute(INTERFACE_FONT_ATTRIBUTE, value)
	else root.removeAttribute(INTERFACE_FONT_ATTRIBUTE)
	if (family !== undefined)
		root.style?.setProperty('--font-sans', familyStack(family, 'var(--font-sans-app)'))
	else root.style?.removeProperty('--font-sans')
}

export function interfaceFontOf(root: FontRoot): InterfaceFont {
	return parseInterfaceFont(root.getAttribute(INTERFACE_FONT_ATTRIBUTE))
}

const listeners = new Set<() => void>()

function root(): FontRoot | undefined {
	return typeof document === 'undefined' ? undefined : document.documentElement
}

/** The choice in force now; the root's attribute is the one source of truth. */
export function currentInterfaceFont(): InterfaceFont {
	const element = root()
	return element ? interfaceFontOf(element) : 'app'
}

/** Take a choice: draw with it at once, remember it, and tell the hooks. No restart is needed. */
export function setInterfaceFont(value: InterfaceFont): void {
	const element = root()
	if (element) applyInterfaceFont(element, value)
	try {
		localStorage.setItem(INTERFACE_FONT_KEY, value)
	} catch {
		/* Storage can be unavailable; the choice still holds until the window closes. */
	}
	for (const listener of [...listeners]) listener()
}

let started = false

/** Read the saved choice once at start and follow a change another window of the app makes. */
export function startInterfaceFont(): void {
	if (started || typeof window === 'undefined') return
	started = true
	try {
		const element = root()
		if (element)
			applyInterfaceFont(element, parseInterfaceFont(localStorage.getItem(INTERFACE_FONT_KEY)))
	} catch {
		/* The boot script already applied what it could read. */
	}
	window.addEventListener('storage', (event) => {
		if (event.key !== INTERFACE_FONT_KEY) return
		const element = root()
		if (element) applyInterfaceFont(element, parseInterfaceFont(event.newValue))
		for (const listener of [...listeners]) listener()
	})
}

/** Tell `listener` after every change of the choice, from this window or another. */
export function subscribeInterfaceFont(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

export function useInterfaceFont(): [InterfaceFont, (value: InterfaceFont) => void] {
	const value = useSyncExternalStore(
		subscribeInterfaceFont,
		currentInterfaceFont,
		() => 'app' as const,
	)
	return [value, setInterfaceFont]
}
