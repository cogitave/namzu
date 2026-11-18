import { CODE_FONT_SIZE_DEFAULT } from '../shared/code-themes.js'
import { RESPONSE_FONT_MATCH, isSafeFontName, storedFamily } from '../shared/settings-catalogue.js'
import type { DesktopSettings } from '../shared/settings-protocol.js'

/**
 * The appearance choices Desktop saves in `desktop-settings.json` and the window draws with. Main
 * owns the saved value; this file turns it into attributes on the root element, which theme.css
 * reads. A copy of the values is kept in this window's storage so `public/theme-boot.js` can set
 * the same attributes before the first paint and a restart shows no flash.
 *
 * Absent attribute = the value Namzu has always had, so nothing moves for someone who changes nothing.
 */
export const APPEARANCE_PREFS_KEY = 'namzu.appearance-prefs'

export type AppearancePrefs = Pick<
	DesktopSettings,
	| 'responseFont'
	| 'transcriptTextSize'
	| 'transcriptWidth'
	| 'motion'
	| 'virtualizeConversations'
	| 'autoDismissPopups'
	| 'lightCodeTheme'
	| 'darkCodeTheme'
	| 'codeFont'
	| 'codeFontSize'
>

/** Where these choices land on the root element. theme.css and public/theme-boot.js use the same names. */
export const PREF_ATTRIBUTES = {
	textSize: 'data-transcript-size',
	width: 'data-transcript-width',
	motion: 'data-motion',
	virtualize: 'data-virtualize',
	responseFont: 'data-response-font',
} as const

export const RESPONSE_FONT_PROPERTY = '--font-response'

/** The tokens the code font and size set inline on the root; theme.css holds today's values. */
export const CODE_FONT_PROPERTIES = ['--font-mono', '--font-terminal'] as const
export const CODE_SIZE_PROPERTY = '--font-size-code'

/** The slice of an element these choices need, so a test can pass a plain object. */
export interface PrefsRoot {
	setAttribute(name: string, value: string): void
	removeAttribute(name: string): void
	style?: { setProperty(name: string, value: string): void; removeProperty(name: string): void }
}

/** The stack a named font is drawn with, the interface's own faces behind it. */
export function familyStack(name: string, fallback: string): string {
	return `"${name.trim()}", ${fallback}`
}

/** The value of `--font-response` for a response font choice; undefined when it follows the interface. */
export function responseFontStack(value: string): string | undefined {
	if (value === RESPONSE_FONT_MATCH || value === '') return undefined
	if (value === 'app') return 'var(--font-sans-app)'
	if (value === 'system') return 'var(--font-sans-system)'
	const family = storedFamily(value)
	return family === undefined ? undefined : familyStack(family, 'var(--font-sans)')
}

function toggleAttribute(root: PrefsRoot, name: string, value: string | undefined) {
	if (value === undefined) root.removeAttribute(name)
	else root.setAttribute(name, value)
}

/** Put the choices on the root: a value that equals the default removes its attribute. */
export function applyAppearancePrefs(root: PrefsRoot, prefs: AppearancePrefs): void {
	toggleAttribute(
		root,
		PREF_ATTRIBUTES.textSize,
		prefs.transcriptTextSize === 'medium' ? undefined : prefs.transcriptTextSize,
	)
	toggleAttribute(
		root,
		PREF_ATTRIBUTES.width,
		prefs.transcriptWidth === 'narrow' ? undefined : prefs.transcriptWidth,
	)
	toggleAttribute(
		root,
		PREF_ATTRIBUTES.motion,
		prefs.motion === 'system' ? undefined : prefs.motion,
	)
	toggleAttribute(
		root,
		PREF_ATTRIBUTES.virtualize,
		prefs.virtualizeConversations ? undefined : 'off',
	)
	const stack = responseFontStack(prefs.responseFont)
	toggleAttribute(root, PREF_ATTRIBUTES.responseFont, stack === undefined ? undefined : 'on')
	if (stack === undefined) root.style?.removeProperty(RESPONSE_FONT_PROPERTY)
	else root.style?.setProperty(RESPONSE_FONT_PROPERTY, stack)
	// The code font takes the place of the mono face for code and the terminal; the interface font
	// and the interface's own `--font-mono` rule are left as they are when it is empty.
	const code = codeFontStack(prefs.codeFont)
	for (const property of CODE_FONT_PROPERTIES)
		if (code === undefined) root.style?.removeProperty(property)
		else root.style?.setProperty(property, code)
	if (prefs.codeFontSize === CODE_FONT_SIZE_DEFAULT) root.style?.removeProperty(CODE_SIZE_PROPERTY)
	else root.style?.setProperty(CODE_SIZE_PROPERTY, `${prefs.codeFontSize}px`)
}

/** The code font as a stack, Namzu's own mono behind it; undefined for empty or an unsafe name. */
export function codeFontStack(value: string): string | undefined {
	return isSafeFontName(value) ? familyStack(value, 'var(--font-mono-app)') : undefined
}

/** What the window keeps for the first paint. Only the choices the first paint draws. */
export function mirrorOf(prefs: AppearancePrefs): Omit<AppearancePrefs, 'autoDismissPopups'> {
	return {
		lightCodeTheme: prefs.lightCodeTheme,
		darkCodeTheme: prefs.darkCodeTheme,
		codeFont: prefs.codeFont,
		codeFontSize: prefs.codeFontSize,
		responseFont: prefs.responseFont,
		transcriptTextSize: prefs.transcriptTextSize,
		transcriptWidth: prefs.transcriptWidth,
		motion: prefs.motion,
		virtualizeConversations: prefs.virtualizeConversations,
	}
}

/** Remember the choices for the next first paint. Storage can be unavailable; the saved setting is the truth. */
export function writePrefsMirror(storage: Pick<Storage, 'setItem'>, prefs: AppearancePrefs): void {
	try {
		storage.setItem(APPEARANCE_PREFS_KEY, JSON.stringify(mirrorOf(prefs)))
	} catch {
		/* The first paint falls back to the defaults. */
	}
}
