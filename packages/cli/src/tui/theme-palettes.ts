/**
 * The colour tables behind every theme. A palette is data only: `theme.ts`
 * holds the live object the TUI reads, and `theme-store.ts` decides which
 * palette fills it.
 *
 * `dark` is the look Namzu has always had (phosphor green on the terminal's
 * own background) and is the default. `light` is its inverse: the same hues
 * pulled darker so they read on a pale background. The two `-daltonized`
 * variants move every red-versus-green meaning (done and failed, added and
 * removed) onto a blue-versus-red axis. The two `-ansi` variants use only the
 * terminal's own sixteen named colours, so they follow whatever colour scheme
 * the terminal is set to.
 */

export const THEME_NAMES = [
	'dark',
	'light',
	'dark-daltonized',
	'light-daltonized',
	'dark-ansi',
	'light-ansi',
] as const

export type ThemeName = (typeof THEME_NAMES)[number]

/** What the setting may hold: a concrete theme, or `auto` (follow the terminal). */
export type ThemeSetting = 'auto' | ThemeName

/**
 * The backgrounds a diff row is drawn on. Six tokens: a whole added or removed row, the same dimmed
 * for a change that was refused, and the words that differ inside a changed pair of rows.
 */
export interface DiffColors {
	readonly added: string
	readonly removed: string
	readonly addedDimmed: string
	readonly removedDimmed: string
	readonly addedWord: string
	readonly removedWord: string
}

export type Rgb = readonly [number, number, number]

export interface SemanticColors {
	/** Canvas background — the whole UI sits on this. */
	readonly background: string
	readonly text: {
		readonly primary: string
		readonly secondary: string
		readonly muted: string
	}
	readonly accent: {
		readonly user: string
		readonly assistant: string
		readonly system: string
		readonly tool: string
		/**
		 * The hypermode session mode's own colour (violet), used wherever the
		 * mode is named: the effort slider's last stop and the composer tag.
		 * Never a status colour.
		 */
		readonly hypermode: string
		/**
		 * An armed composer trigger (sky): its words in the draft and its tag
		 * row. Kept apart from the session mode's violet, which names what lasts
		 * for the session; a trigger lasts one message.
		 */
		readonly trigger: string
		/** Plan mode in the footer's mode item (teal). */
		readonly plan: string
		/** Background shells in the footer pill (cyan). */
		readonly shells: string
	}
	readonly status: {
		readonly ok: string
		readonly warn: string
		readonly error: string
		/** A merged pull request (purple). */
		readonly merged: string
	}
	readonly border: {
		readonly default: string
		readonly focus: string
	}
	/**
	 * The working line's three letter states: already swept, the sweep's edge and
	 * not yet reached. `rgb` is where the stall tint starts from; absent for a
	 * palette that may only use named colours, which then never tints.
	 */
	readonly live: {
		readonly done: string
		readonly edge: string
		readonly ahead: string
		readonly rgb?: { readonly done: Rgb; readonly edge: Rgb; readonly ahead: Rgb }
	}
	/** The hypermode glow on the composer's rule: three steps, light to deep. */
	readonly glow: readonly [string, string, string]
	/** Diff row backgrounds: for a terminal with 24-bit colour, and for every other one. */
	readonly diff: { readonly truecolor: DiffColors; readonly basic: DiffColors }
}

const NAMED_DIFF: DiffColors = {
	added: 'green',
	removed: 'red',
	addedDimmed: 'green',
	removedDimmed: 'red',
	addedWord: 'greenBright',
	removedWord: 'redBright',
}

const NAMED_DIFF_COLOURBLIND: DiffColors = {
	added: 'blue',
	removed: 'red',
	addedDimmed: 'blue',
	removedDimmed: 'red',
	addedWord: 'blueBright',
	removedWord: 'redBright',
}

const DARK: SemanticColors = {
	background: '#0b0f0c',
	text: { primary: 'ansi256(252)', secondary: 'ansi256(248)', muted: 'ansi256(245)' },
	accent: {
		user: 'ansi256(83)',
		assistant: 'ansi256(83)',
		system: 'ansi256(109)',
		tool: 'ansi256(248)',
		hypermode: 'ansi256(141)',
		trigger: 'ansi256(117)',
		plan: 'ansi256(73)',
		shells: 'ansi256(37)',
	},
	status: {
		ok: 'ansi256(77)',
		warn: 'ansi256(221)',
		error: 'ansi256(203)',
		merged: 'ansi256(135)',
	},
	border: { default: 'ansi256(239)', focus: 'ansi256(83)' },
	live: {
		done: 'greenBright',
		edge: 'whiteBright',
		ahead: 'ansi256(245)',
		rgb: { done: [85, 255, 85], edge: [255, 255, 255], ahead: [138, 138, 138] },
	},
	glow: ['ansi256(183)', 'ansi256(141)', 'ansi256(97)'],
	diff: {
		truecolor: {
			added: 'rgb(34,92,43)',
			removed: 'rgb(122,41,54)',
			addedDimmed: 'rgb(71,88,74)',
			removedDimmed: 'rgb(105,72,77)',
			addedWord: 'rgb(56,166,96)',
			removedWord: 'rgb(179,89,107)',
		},
		basic: NAMED_DIFF,
	},
}

const LIGHT: SemanticColors = {
	background: '#ffffff',
	text: { primary: 'ansi256(235)', secondary: 'ansi256(239)', muted: 'ansi256(243)' },
	accent: {
		user: 'ansi256(28)',
		assistant: 'ansi256(28)',
		system: 'ansi256(24)',
		tool: 'ansi256(239)',
		hypermode: 'ansi256(91)',
		trigger: 'ansi256(25)',
		plan: 'ansi256(30)',
		shells: 'ansi256(30)',
	},
	status: {
		ok: 'ansi256(28)',
		warn: 'ansi256(130)',
		error: 'ansi256(124)',
		merged: 'ansi256(91)',
	},
	border: { default: 'ansi256(250)', focus: 'ansi256(28)' },
	live: {
		done: 'ansi256(28)',
		edge: 'ansi256(16)',
		ahead: 'ansi256(243)',
		rgb: { done: [0, 135, 0], edge: [0, 0, 0], ahead: [118, 118, 118] },
	},
	glow: ['ansi256(97)', 'ansi256(91)', 'ansi256(55)'],
	diff: {
		truecolor: {
			added: 'rgb(200,238,208)',
			removed: 'rgb(255,214,220)',
			addedDimmed: 'rgb(226,236,228)',
			removedDimmed: 'rgb(240,226,228)',
			addedWord: 'rgb(128,213,146)',
			removedWord: 'rgb(244,158,170)',
		},
		basic: NAMED_DIFF,
	},
}

const DARK_DALTONIZED: SemanticColors = {
	...DARK,
	accent: { ...DARK.accent, user: 'ansi256(81)', assistant: 'ansi256(81)' },
	status: {
		ok: 'ansi256(75)',
		warn: 'ansi256(220)',
		error: 'ansi256(209)',
		merged: 'ansi256(135)',
	},
	border: { default: 'ansi256(239)', focus: 'ansi256(81)' },
	live: {
		done: 'ansi256(81)',
		edge: 'whiteBright',
		ahead: 'ansi256(245)',
		rgb: { done: [95, 215, 255], edge: [255, 255, 255], ahead: [138, 138, 138] },
	},
	diff: {
		truecolor: {
			added: 'rgb(0,68,102)',
			removed: 'rgb(102,0,0)',
			addedDimmed: 'rgb(52,72,86)',
			removedDimmed: 'rgb(86,52,52)',
			addedWord: 'rgb(0,119,179)',
			removedWord: 'rgb(179,0,0)',
		},
		basic: NAMED_DIFF_COLOURBLIND,
	},
}

const LIGHT_DALTONIZED: SemanticColors = {
	...LIGHT,
	accent: {
		...LIGHT.accent,
		user: 'ansi256(25)',
		assistant: 'ansi256(25)',
		trigger: 'ansi256(30)',
	},
	status: { ok: 'ansi256(25)', warn: 'ansi256(130)', error: 'ansi256(160)', merged: 'ansi256(91)' },
	border: { default: 'ansi256(250)', focus: 'ansi256(25)' },
	live: {
		done: 'ansi256(25)',
		edge: 'ansi256(16)',
		ahead: 'ansi256(243)',
		rgb: { done: [0, 95, 175], edge: [0, 0, 0], ahead: [118, 118, 118] },
	},
	diff: {
		truecolor: {
			added: 'rgb(190,222,250)',
			removed: 'rgb(255,208,208)',
			addedDimmed: 'rgb(222,232,242)',
			removedDimmed: 'rgb(240,226,226)',
			addedWord: 'rgb(120,170,230)',
			removedWord: 'rgb(240,140,140)',
		},
		basic: NAMED_DIFF_COLOURBLIND,
	},
}

const DARK_ANSI: SemanticColors = {
	background: 'black',
	text: { primary: 'whiteBright', secondary: 'white', muted: 'blackBright' },
	accent: {
		user: 'greenBright',
		assistant: 'greenBright',
		system: 'cyan',
		tool: 'white',
		hypermode: 'magentaBright',
		trigger: 'cyanBright',
		plan: 'cyan',
		shells: 'blue',
	},
	status: { ok: 'green', warn: 'yellow', error: 'redBright', merged: 'magenta' },
	border: { default: 'blackBright', focus: 'greenBright' },
	live: { done: 'greenBright', edge: 'whiteBright', ahead: 'blackBright' },
	glow: ['magentaBright', 'magenta', 'blackBright'],
	diff: { truecolor: NAMED_DIFF, basic: NAMED_DIFF },
}

const LIGHT_ANSI: SemanticColors = {
	background: 'white',
	text: { primary: 'black', secondary: 'blackBright', muted: 'blackBright' },
	accent: {
		user: 'green',
		assistant: 'green',
		system: 'blue',
		tool: 'blackBright',
		hypermode: 'magenta',
		trigger: 'blue',
		plan: 'cyan',
		shells: 'cyan',
	},
	status: { ok: 'green', warn: 'yellow', error: 'red', merged: 'magenta' },
	border: { default: 'blackBright', focus: 'green' },
	live: { done: 'green', edge: 'black', ahead: 'blackBright' },
	glow: ['magentaBright', 'magenta', 'blackBright'],
	diff: { truecolor: NAMED_DIFF, basic: NAMED_DIFF },
}

export const PALETTES: Readonly<Record<ThemeName, SemanticColors>> = {
	dark: DARK,
	light: LIGHT,
	'dark-daltonized': DARK_DALTONIZED,
	'light-daltonized': LIGHT_DALTONIZED,
	'dark-ansi': DARK_ANSI,
	'light-ansi': LIGHT_ANSI,
}

/** The picker's rows, in order: label and a plain line on what the theme is for. */
export const THEME_CHOICES: readonly {
	readonly value: ThemeSetting
	readonly label: string
	readonly description: string
}[] = [
	{
		value: 'auto',
		label: 'Auto (match terminal)',
		description: 'Dark or light, as the terminal is.',
	},
	{ value: 'dark', label: 'Dark mode', description: 'Namzu’s own look, for a dark terminal.' },
	{ value: 'light', label: 'Light mode', description: 'The same look, for a light terminal.' },
	{
		value: 'dark-daltonized',
		label: 'Dark mode (colorblind-friendly)',
		description: 'Blue and red in place of green and red.',
	},
	{
		value: 'light-daltonized',
		label: 'Light mode (colorblind-friendly)',
		description: 'Blue and red in place of green and red.',
	},
	{
		value: 'dark-ansi',
		label: 'Dark mode (ANSI colors only)',
		description: 'Only the terminal’s own sixteen colors.',
	},
	{
		value: 'light-ansi',
		label: 'Light mode (ANSI colors only)',
		description: 'Only the terminal’s own sixteen colors.',
	},
]

/** The picker label for a setting, e.g. `Dark mode`. */
export function themeLabel(setting: ThemeSetting): string {
	return THEME_CHOICES.find((choice) => choice.value === setting)?.label ?? 'Dark mode'
}

/** A setting from user input: the exact name, or undefined when it is not one. */
export function parseThemeSetting(value: unknown): ThemeSetting | undefined {
	if (value === 'auto') return 'auto'
	return THEME_NAMES.find((name) => name === value)
}

/** `auto` follows what was detected (dark when nothing was); a name is itself. */
export function resolveTheme(setting: unknown, detected: 'dark' | 'light' | undefined): ThemeName {
	const parsed = parseThemeSetting(setting)
	if (parsed === undefined) return 'dark'
	if (parsed === 'auto') return detected ?? 'dark'
	return parsed
}
