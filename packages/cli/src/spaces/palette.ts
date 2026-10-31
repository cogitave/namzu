import { DEFAULT_COLOR, rgb } from '../terminal/host/cell.js'

/** The colours the host draws its own chrome in. */
export interface Palette {
	/** The focused pane's border, the active tab and keys in the mode bar. */
	readonly accent: number
	/** The mode bar and the tab bar. */
	readonly panelBg: number
	/** The tab bar's resting tabs. */
	readonly surface: number
	/** Text on a resting tab: dim, except where the 16 colours leave no contrast. */
	readonly tabRest: number
	/** The border of a pane without focus, and dim text. */
	readonly dim: number
	readonly dimmer: number
	readonly text: number
	readonly subtext: number
	/** The resize mode's chip. */
	readonly mauve: number
	readonly green: number
	readonly yellow: number
	readonly red: number
	readonly teal: number
	/** The faint tint behind the shown space and the pane in focus. */
	readonly activeRow: number
	/** The stronger tint behind the row the navigate cursor is on. */
	readonly cursorRow: number
}

type Rgb = readonly [number, number, number]

const TRUE: Record<Exclude<keyof Palette, 'tabRest' | 'activeRow' | 'cursorRow'>, Rgb> = {
	accent: [137, 180, 250],
	panelBg: [24, 24, 37],
	surface: [49, 50, 68],
	dim: [108, 112, 134],
	dimmer: [127, 132, 156],
	text: [205, 214, 244],
	subtext: [166, 173, 200],
	mauve: [203, 166, 247],
	green: [166, 227, 161],
	yellow: [249, 226, 175],
	red: [243, 139, 168],
	teal: [148, 226, 213],
}

/** The usual values of the 16 terminal colours, to find the nearest to a true colour. */
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

/** The index of the 16 colours nearest to a true colour. */
export function nearestAnsi(color: Rgb): number {
	let best = 0
	let bestDistance = Number.POSITIVE_INFINITY
	ANSI.forEach((candidate, index) => {
		const d =
			(candidate[0] - color[0]) ** 2 +
			(candidate[1] - color[1]) ** 2 +
			(candidate[2] - color[2]) ** 2
		if (d < bestDistance) {
			bestDistance = d
			best = index
		}
	})
	return best
}

/** Whether the terminal says it shows true colour. */
export function advertisesTruecolor(env: NodeJS.ProcessEnv): boolean {
	return /^(truecolor|24bit)$/iu.test(env.COLORTERM ?? '')
}

/** The default palette in true colour, or its nearest 16 colours where that is not shown. */
export function paletteFor(truecolor: boolean): Palette {
	const out = {} as Record<keyof Palette, number>
	for (const key of Object.keys(TRUE) as (keyof typeof TRUE)[]) {
		const c = TRUE[key]
		out[key] = truecolor ? rgb(c[0], c[1], c[2]) : nearestAnsi(c)
	}
	// Both tints are near black. In 16 colours the faint one is left out (the bold name
	// carries the selection) and the strong one becomes bright black.
	out.activeRow = truecolor ? rgb(30, 30, 46) : DEFAULT_COLOR
	out.cursorRow = truecolor ? rgb(49, 50, 68) : 8
	out.tabRest = out.dim
	// Both would land on black; a raised tab keeps its look as bright black, with white text.
	if (!truecolor && out.surface === out.panelBg) {
		out.surface = 8
		out.tabRest = 7
	}
	return out
}
