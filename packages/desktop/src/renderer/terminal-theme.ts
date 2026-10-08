import type { ITheme } from '@xterm/xterm'

/** The sixteen ANSI colours, chosen to read on the app's own background in each appearance. */
const DARK_ANSI = [
	'#5b5b66',
	'#f87171',
	'#4ade80',
	'#facc15',
	'#60a5fa',
	'#c084fc',
	'#22d3ee',
	'#d4d4d8',
	'#8b8b94',
	'#fca5a5',
	'#86efac',
	'#fde047',
	'#93c5fd',
	'#d8b4fe',
	'#67e8f9',
	'#fafafa',
] as const
const LIGHT_ANSI = [
	'#27272a',
	'#c10007',
	'#176b29',
	'#9a6700',
	'#1d4ed8',
	'#7e22ce',
	'#0e7490',
	'#71717b',
	'#52525b',
	'#dc2626',
	'#15803d',
	'#a16207',
	'#2563eb',
	'#9333ea',
	'#0891b2',
	'#3f3f46',
] as const

const NAMES = [
	'black',
	'red',
	'green',
	'yellow',
	'blue',
	'magenta',
	'cyan',
	'white',
	'brightBlack',
	'brightRed',
	'brightGreen',
	'brightYellow',
	'brightBlue',
	'brightMagenta',
	'brightCyan',
	'brightWhite',
] as const

/**
 * The terminal's colours from the app's tokens: the background and text are the app's own, so a
 * terminal tab sits in the window rather than on it. `read` answers a CSS custom property.
 */
export function terminalTheme(read: (name: string) => string, dark: boolean): ITheme {
	const ansi = dark ? DARK_ANSI : LIGHT_ANSI
	const background = read('--background') || (dark ? '#09090b' : '#ffffff')
	const foreground = read('--foreground') || (dark ? '#e4e4e7' : '#27272a')
	const accent = read('--primary') || foreground
	const theme: Record<string, string> = {
		background,
		foreground,
		cursor: accent,
		cursorAccent: background,
		// Opaque with its own text colour: a translucent overlay left reverse-video text unreadable.
		selectionBackground: dark ? '#2f4f85' : '#b9cdf7',
		selectionForeground: dark ? '#ffffff' : '#18181b',
		selectionInactiveBackground: dark ? 'rgba(161, 161, 170, 0.25)' : 'rgba(113, 113, 123, 0.2)',
	}
	NAMES.forEach((name, index) => {
		theme[name] = ansi[index] as string
	})
	return theme as ITheme
}

/** The font stack the app uses for code, read from its token. */
export function terminalFontFamily(read: (name: string) => string): string {
	return (
		read('--font-mono') ||
		'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
	)
}
