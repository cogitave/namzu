import { DEFAULT_COLOR, rgb } from '../terminal/host/cell.js'
import { activeThemeName, reportsTruecolor, theme } from '../tui/theme.js'
import type { SemanticColors, ThemeName } from '../tui/theme.js'

/** How many colours the terminal shows, which decides how a theme colour is written. */
export type ColorLevel = 'none' | '16' | '256' | 'truecolor'

/**
 * The colours the host draws its own chrome in.
 *
 * Every role is a colour of the main Namzu theme (`tui/theme.ts`), written in the form the
 * terminal can show, so the chrome follows the theme the rest of the TUI is drawn in: dark,
 * light, the colour-blind variants and the plain ANSI ones. Nothing here is a colour of its own.
 */
export interface Palette {
	/** True when there is no colour at all: roles are the terminal default and shape carries the meaning. */
	readonly mono: boolean
	/** The terminal's own background; the bar and the modals are not painted a colour of their own. */
	readonly base: number
	/** Text on a filled accent chip: the theme's canvas colour. */
	readonly ink: number
	/** The active tab, the keys in the mode bar and the picked row of a list. */
	readonly accent: number
	/** The border of the focused pane and of a modal. */
	readonly focus: number
	/** The border of a pane without focus, and the rule under the tab bar. */
	readonly border: number
	/** Quiet text: resting tabs, hints, labels. */
	readonly dim: number
	readonly text: number
	readonly subtext: number
	/** The input fields and buttons of a modal. */
	readonly surface: number
	/** The faint tint behind the shown workspace and the pane in focus. */
	readonly activeRow: number
	/** The stronger tint behind the row the navigate cursor is on. */
	readonly cursorRow: number
	/** State dots: something works, nothing runs, something waits for you, something finished. */
	readonly working: number
	readonly idle: number
	readonly blocked: number
	readonly done: number
	/** Commits ahead of and behind the upstream. */
	readonly ahead: number
	readonly behind: number
	/** The branch line under a workspace. */
	readonly branch: number
	/** A warning or notice. */
	readonly warn: number
	/** What a destructive question is drawn in. */
	readonly danger: number
	/** The chips of the mode bar; prefix mode uses `accent`. */
	readonly navigate: number
	readonly resize: number
}

type Rgb = readonly [number, number, number]

const NAMED: Readonly<Record<string, number>> = {
	black: 0,
	red: 1,
	green: 2,
	yellow: 3,
	blue: 4,
	magenta: 5,
	cyan: 6,
	white: 7,
	blackBright: 8,
	gray: 8,
	grey: 8,
	redBright: 9,
	greenBright: 10,
	yellowBright: 11,
	blueBright: 12,
	magentaBright: 13,
	cyanBright: 14,
	whiteBright: 15,
}

/** The usual values of the 16 terminal colours, to find the nearest to another colour. */
const ANSI: readonly Rgb[] = [
	[0, 0, 0],
	[205, 0, 0],
	[0, 205, 0],
	[205, 205, 0],
	[0, 0, 238],
	[205, 0, 205],
	[0, 205, 205],
	[229, 229, 229],
	[127, 127, 127],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[92, 92, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255],
]

const CUBE = [0, 95, 135, 175, 215, 255]

/** The colour of an entry of the 256-colour palette. */
function xterm(index: number): Rgb {
	if (index < 16) return ANSI[index] as Rgb
	if (index >= 232) {
		const v = 8 + 10 * (index - 232)
		return [v, v, v]
	}
	const n = index - 16
	return [
		CUBE[Math.floor(n / 36)] as number,
		CUBE[Math.floor(n / 6) % 6] as number,
		CUBE[n % 6] as number,
	]
}

function nearest(color: Rgb, from: number, to: number): number {
	let best = from
	let bestDistance = Number.POSITIVE_INFINITY
	for (let i = from; i < to; i++) {
		const c = xterm(i)
		const d = (c[0] - color[0]) ** 2 + (c[1] - color[1]) ** 2 + (c[2] - color[2]) ** 2
		if (d < bestDistance) {
			bestDistance = d
			best = i
		}
	}
	return best
}

/** The index of the 16 colours nearest to another colour. */
export function nearestAnsi(color: Rgb): number {
	return nearest(color, 0, 16)
}

function parseRgb(token: string): Rgb | undefined {
	const hex = /^#([0-9a-f]{6})$/iu.exec(token)
	if (hex) {
		const v = Number.parseInt(hex[1] as string, 16)
		return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
	}
	const fn = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/iu.exec(token)
	if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])]
	return undefined
}

/**
 * The cell colour a theme token is drawn as. An `ansi256(n)` token is that palette entry itself (the
 * main TUI draws it the same way, so no hue is approximated), a name is one of the 16 colours, and a
 * hex or `rgb(...)` token is true colour where the terminal shows it and the nearest entry elsewhere.
 */
export function resolveColor(token: string, level: ColorLevel): number {
	if (level === 'none') return DEFAULT_COLOR
	const indexed = /^ansi256\((\d{1,3})\)$/u.exec(token)
	if (indexed) {
		const index = Math.min(255, Number(indexed[1]))
		return level === '16' ? nearestAnsi(xterm(index)) : index
	}
	const named = NAMED[token]
	if (named !== undefined) return named
	const color = parseRgb(token)
	if (!color) return DEFAULT_COLOR
	if (level === 'truecolor') return rgb(color[0], color[1], color[2])
	return level === '256' ? nearest(color, 16, 256) : nearestAnsi(color)
}

/** How much colour this terminal shows: none when `NO_COLOR` or a dumb terminal asks for it. */
export function colorLevel(env: NodeJS.ProcessEnv): ColorLevel {
	if ((env.NO_COLOR ?? '') !== '' || env.FORCE_COLOR === '0' || env.TERM === 'dumb') return 'none'
	if (reportsTruecolor(env)) return 'truecolor'
	if (/256/u.test(env.TERM ?? '')) return '256'
	return '16'
}

/** Whether the terminal says it shows true colour; what the main TUI uses, so both agree. */
export function advertisesTruecolor(env: NodeJS.ProcessEnv): boolean {
	return reportsTruecolor(env)
}

interface Tints {
	readonly activeRow: string
	readonly cursorRow: string
	readonly surface: string
}

/** The faint tints the sidebar lays behind a row. The theme has no token for them, so each theme family names its own. */
function tintsOf(name: ThemeName): Tints {
	if (name.endsWith('-ansi'))
		return { activeRow: 'blackBright', cursorRow: 'blackBright', surface: 'blackBright' }
	if (name.startsWith('light'))
		return { activeRow: 'ansi256(255)', cursorRow: 'ansi256(253)', surface: 'ansi256(254)' }
	return { activeRow: 'ansi256(235)', cursorRow: 'ansi256(237)', surface: 'ansi256(236)' }
}

/**
 * The palette for a colour level, from a theme: by default the one the TUI is showing now. At 16
 * colours both tints become bright black, so the shown workspace still stands out (the sidebar lifts
 * text that would otherwise match the tint).
 */
export function paletteFor(
	level: ColorLevel,
	source: { readonly theme: SemanticColors; readonly name: ThemeName } = {
		theme,
		name: activeThemeName(),
	},
): Palette {
	const t = source.theme
	const c = (token: string): number => resolveColor(token, level)
	const tints = tintsOf(source.name)
	const tint = (token: string): number =>
		level === '16' ? resolveColor('blackBright', level) : c(token)
	return {
		mono: level === 'none',
		base: DEFAULT_COLOR,
		ink: c(t.background),
		accent: c(t.accent.assistant),
		focus: c(t.border.focus),
		border: c(t.border.default),
		dim: c(t.text.muted),
		text: c(t.text.primary),
		subtext: c(t.text.secondary),
		surface: tint(tints.surface),
		activeRow: tint(tints.activeRow),
		cursorRow: tint(tints.cursorRow),
		working: c(t.status.warn),
		idle: c(t.text.muted),
		blocked: c(t.status.error),
		done: c(t.accent.shells),
		ahead: c(t.status.ok),
		behind: c(t.status.error),
		branch: c(t.accent.system),
		warn: c(t.status.warn),
		danger: c(t.status.error),
		navigate: c(t.accent.trigger),
		resize: c(t.accent.hypermode),
	}
}
