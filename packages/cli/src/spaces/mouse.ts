/**
 * How much of the pointer the spaces screen asks the terminal to report.
 *
 * `full` reports presses, releases and drags (the sidebar, tabs, borders and text
 * selection need them), `scroll` reports only the wheel and presses nothing the host
 * acts on, `off` asks for nothing so the terminal keeps its own selection.
 */
export type MouseMode = 'full' | 'scroll' | 'off'

const CSI = '\x1b['

/** Turns off every pointer mode a program may have left on, widest list first. */
export const MOUSE_OFF = ['1006', '1016', '1015', '1005', '1003', '1002', '1000', '9']
	.map((mode) => `${CSI}?${mode}l`)
	.join('')

const FALSE_VALUES = new Set(['', '0', 'false', 'no', 'off'])

function truthy(value: string | undefined): boolean {
	return value !== undefined && !FALSE_VALUES.has(value.trim().toLowerCase())
}

/**
 * The mode in force: `NAMZU_DISABLE_MOUSE` turns the pointer off, then
 * `NAMZU_DISABLE_MOUSE_CLICKS` keeps only the wheel, then the `tui.mouse` setting;
 * otherwise `full`.
 */
export function resolveMouseMode(
	env: Readonly<Record<string, string | undefined>>,
	setting?: MouseMode,
): MouseMode {
	if (truthy(env.NAMZU_DISABLE_MOUSE)) return 'off'
	if (truthy(env.NAMZU_DISABLE_MOUSE_CLICKS)) return 'scroll'
	return setting ?? 'full'
}

/** The sequence that switches the pointer reporting of `mode` on; nothing for `off`. */
export function mouseOn(mode: MouseMode): string {
	if (mode === 'full') return `${CSI}?1000h${CSI}?1002h${CSI}?1006h`
	if (mode === 'scroll') return `${CSI}?1000h${CSI}?1006h`
	return ''
}

/** Takes the alternate screen, clears it and switches the pointer on. Anything left on is reset first. */
export function enterScreen(mode: MouseMode): string {
	return `${MOUSE_OFF}${CSI}?1049h${CSI}2J${mouseOn(mode)}`
}

/** Hands the terminal to a session that draws on the main screen: pointer off, main screen back. */
export const LEAVE_TO_NATIVE = `${MOUSE_OFF}${CSI}?1049l`

/** Gives the terminal back for good: pointer off, paste mode off, cursor shown, main screen back. */
export const LEAVE_SCREEN = `${MOUSE_OFF}${CSI}?2004l${CSI}?25h${CSI}?1049l`

/**
 * Clears pointer reporting a killed earlier run may have left on the terminal. Written once at the
 * start of an interactive launch, before the first frame; nothing for a stream that is not a
 * terminal, or for a session a spaces host runs (its terminal is the host's own emulator).
 */
export function writeLaunchMouseReset(
	out: { readonly isTTY?: boolean; write(text: string): unknown },
	hosted: boolean,
): boolean {
	if (!out.isTTY || hosted) return false
	out.write(MOUSE_OFF)
	return true
}
