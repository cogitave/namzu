/**
 * The colour sets code can be drawn in (blocks of a diff, a file view). Each choice is named by how
 * it looks; the ids are the highlighter's own bundled themes, so nothing is downloaded. `default`
 * is what Namzu has always drawn.
 */
export const CODE_THEME_KEYS = ['default', 'soft', 'vivid', 'contrast', 'warm'] as const
export type CodeThemeKey = (typeof CODE_THEME_KEYS)[number]

export interface CodeThemeChoice {
	value: CodeThemeKey
	label: string
	help: string
	/** The highlighter's theme for each appearance. */
	light: string
	dark: string
}

export const CODE_THEMES: readonly CodeThemeChoice[] = [
	{
		value: 'default',
		label: 'Default',
		help: 'The colours Namzu has always used.',
		light: 'pierre-light',
		dark: 'pierre-dark',
	},
	{
		value: 'soft',
		label: 'Soft',
		help: 'Gentler colours with less contrast between them.',
		light: 'pierre-light-soft',
		dark: 'pierre-dark-soft',
	},
	{
		value: 'vivid',
		label: 'Vivid',
		help: 'Stronger, more saturated colours.',
		light: 'pierre-light-vibrant',
		dark: 'pierre-dark-vibrant',
	},
	{
		value: 'contrast',
		label: 'High contrast',
		help: 'The strongest difference between text and background.',
		light: 'github-light-high-contrast',
		dark: 'github-dark-high-contrast',
	},
	{
		value: 'warm',
		label: 'Warm',
		help: 'Earth tones: browns, oranges and muted greens.',
		light: 'gruvbox-light-medium',
		dark: 'gruvbox-dark-medium',
	},
]

export function isCodeThemeKey(value: unknown): value is CodeThemeKey {
	return CODE_THEME_KEYS.includes(value as CodeThemeKey)
}

/** The highlighter's themes for a pair of choices; an unknown choice is the default. */
export function codeThemeIds(
	light: unknown,
	dark: unknown,
): { light: string; dark: string; lightKey: CodeThemeKey; darkKey: CodeThemeKey } {
	const lightKey = isCodeThemeKey(light) ? light : 'default'
	const darkKey = isCodeThemeKey(dark) ? dark : 'default'
	const pick = (key: CodeThemeKey) =>
		CODE_THEMES.find((theme) => theme.value === key) as CodeThemeChoice
	return { light: pick(lightKey).light, dark: pick(darkKey).dark, lightKey, darkKey }
}

/** The sizes the code size row offers, in px. 13 is what Namzu has always drawn. */
export const CODE_FONT_SIZE_MIN = 11
export const CODE_FONT_SIZE_MAX = 18
export const CODE_FONT_SIZE_DEFAULT = 13
