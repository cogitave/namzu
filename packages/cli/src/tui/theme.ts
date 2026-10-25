/**
 * Theme tokens for the TUI. The default is `dark`: phosphor green, neutral
 * text and quiet graphite. We inherit the terminal's own background rather
 * than painting one, and only theme the foreground. Explicit ANSI indices
 * avoid Chalk's RGB cube approximation, which can turn an intended palette
 * color into a different hue.
 *
 * `theme` is read at render time (`theme.text.muted`), never copied into a
 * module-level constant: the active theme can change while the TUI runs (see
 * `theme-store.ts`), and a constant would keep the old colours. The palettes
 * themselves live in `theme-palettes.ts`.
 */

import { type DiffColors, PALETTES, type SemanticColors, type ThemeName } from './theme-palettes.js'

export type { DiffColors, SemanticColors, ThemeName }

const initial = PALETTES.dark

/** The active palette. Mutated in place by `applyPalette`; read, never written, elsewhere. */
export const theme: SemanticColors = {
	background: initial.background,
	text: { ...initial.text },
	accent: { ...initial.accent },
	status: { ...initial.status },
	border: { ...initial.border },
	live: { ...initial.live },
	glow: [...initial.glow],
	diff: { truecolor: initial.diff.truecolor, basic: initial.diff.basic },
}

let activeName: ThemeName = 'dark'

/** Make `name` the active palette. The store calls this and then tells the screen to redraw. */
export function applyPalette(name: ThemeName): void {
	const palette = PALETTES[name]
	const target = theme as { -readonly [K in keyof SemanticColors]: SemanticColors[K] }
	target.background = palette.background
	target.text = { ...palette.text }
	target.accent = { ...palette.accent }
	target.status = { ...palette.status }
	target.border = { ...palette.border }
	target.live = { ...palette.live }
	target.glow = [...palette.glow]
	target.diff = { truecolor: palette.diff.truecolor, basic: palette.diff.basic }
	activeName = name
}

/** The name of the palette currently applied. */
export function activeThemeName(): ThemeName {
	return activeName
}

/** The dark theme's diff colours for a terminal that reports 24-bit colour. */
export const DIFF_COLORS_TRUECOLOR: DiffColors = PALETTES.dark.diff.truecolor

/** The dark theme's diff colours for every other terminal: named ANSI colours, words in the bright variant. */
export const DIFF_COLORS_ANSI: DiffColors = PALETTES.dark.diff.basic

const TRUECOLOR_PROGRAMS = new Set(['iTerm.app', 'vscode', 'WezTerm', 'ghostty', 'Hyper'])

/** Whether the terminal says it draws 24-bit colour. */
export function reportsTruecolor(env: NodeJS.ProcessEnv = process.env): boolean {
	const colorterm = env.COLORTERM?.toLowerCase()
	if (colorterm === 'truecolor' || colorterm === '24bit') return true
	if (env.WT_SESSION !== undefined) return true
	if (env.TERM_PROGRAM !== undefined && TRUECOLOR_PROGRAMS.has(env.TERM_PROGRAM)) return true
	return /direct|truecolor|24bit/i.test(env.TERM ?? '')
}

/** The diff colours the active theme draws on this terminal. */
export function diffColors(env: NodeJS.ProcessEnv = process.env): DiffColors {
	return reportsTruecolor(env) ? theme.diff.truecolor : theme.diff.basic
}

/** The colour groups a row may name by token. */
type RowTokenGroup = 'text' | 'accent' | 'status' | 'border'

/** A theme colour a row is allowed to carry, as `group.name` (`status.error`). */
export type ThemeToken = {
	[G in RowTokenGroup]: `${G}.${keyof SemanticColors[G] & string}`
}[RowTokenGroup]

const TOKEN_MARK = 'theme:'

/**
 * A colour for a row that is stored and drawn later. It is the token's name,
 * not its value, so a row already on screen is drawn in the colours of the theme
 * that is active when it is drawn, not the one it was written under.
 */
export function tokenColor(token: ThemeToken): string {
	return `${TOKEN_MARK}${token}`
}

/** The colour to draw: a stored token is looked up in the active theme, any other colour is kept. */
export function paint(color: string): string
export function paint(color: string | undefined): string | undefined
export function paint(color: string | undefined): string | undefined {
	if (color === undefined || !color.startsWith(TOKEN_MARK)) return color
	const [group, name] = color.slice(TOKEN_MARK.length).split('.') as [RowTokenGroup, string]
	const value = (theme[group] as Record<string, string> | undefined)?.[name]
	return value ?? theme.text.muted
}
