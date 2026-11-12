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
	context: { ...initial.context },
	glow: [...initial.glow],
	tint: { ...initial.tint },
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
	target.context = { ...palette.context }
	target.glow = [...palette.glow]
	target.tint = { ...palette.tint }
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
	if (env.FORCE_COLOR === '3') return true
	const colorterm = env.COLORTERM?.toLowerCase()
	if (colorterm === 'truecolor' || colorterm === '24bit') return true
	if (env.WT_SESSION !== undefined) return true
	if (env.TERM_PROGRAM !== undefined && TRUECOLOR_PROGRAMS.has(env.TERM_PROGRAM)) return true
	return /direct|truecolor|24bit/i.test(env.TERM ?? '')
}

/**
 * Whether the terminal draws a background tint at all: 256 colours or more, and
 * not asked to go without (`NO_COLOR`, `FORCE_COLOR=0`, a dumb terminal, a CI run
 * that did not force colour). Where it does not, a row looks as it always did.
 */
export function drawsTint(env: NodeJS.ProcessEnv = process.env): boolean {
	if ((env.NO_COLOR ?? '') !== '' || env.FORCE_COLOR === '0' || env.TERM === 'dumb') return false
	const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== ''
	if (!forced && (env.CI ?? '') !== '') return false
	if (env.FORCE_COLOR === '1') return false
	return forced || reportsTruecolor(env) || /256color/i.test(env.TERM ?? '')
}

/** The backgrounds behind the person's message and a queued one; null where none is drawn. */
export function rowTints(
	env: NodeJS.ProcessEnv = process.env,
): { readonly user: string; readonly queued: string } | null {
	if (theme.tint.user === '' || !drawsTint(env)) return null
	if (reportsTruecolor(env)) return theme.tint
	return { user: tintOn256(theme.tint.user, false), queued: tintOn256(theme.tint.queued, true) }
}

/**
 * A tint for a 256-colour terminal. Rounding a near-black rgb to the colour cube
 * lands on a mid grey (palette 59), far louder than the quiet tint meant; the
 * grey ramp (232-255) has the right steps, so one is chosen by how light the
 * tint is: 235 or 236 on a dark theme, 255 or 254 on a light one.
 */
function tintOn256(rgb: string, queued: boolean): string {
	const channels = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/u.exec(rgb)
	if (!channels) return rgb
	const light = (Number(channels[1]) + Number(channels[2]) + Number(channels[3])) / 3 >= 128
	const step = light ? (queued ? 254 : 255) : queued ? 236 : 235
	return `ansi256(${step})`
}

/** The diff colours the active theme draws on this terminal. */
export function diffColors(env: NodeJS.ProcessEnv = process.env): DiffColors {
	return reportsTruecolor(env) ? theme.diff.truecolor : theme.diff.basic
}

/** The colour groups a row may name by token. */
type RowTokenGroup = 'text' | 'accent' | 'status' | 'border' | 'context'

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

/** A tint (`rgb(r,g,b)` or `ansi256(n)`) as the escape that sets it as the background; '' for any other. */
export function tintEscape(tint: string): string {
	const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/u.exec(tint)
	if (rgb) return `\x1b[48;2;${rgb[1]};${rgb[2]};${rgb[3]}m`
	const grey = /^ansi256\((\d+)\)$/u.exec(tint)
	return grey ? `\x1b[48;5;${grey[1]}m` : ''
}
