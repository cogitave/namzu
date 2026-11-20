/**
 * Whether the terminal UI draws fullscreen: on the alternate screen, with its
 * own scrolling and the pointer. On unless turned off: `NAMZU_FULLSCREEN=0`,
 * `tui.fullscreen: false`, or a record that fullscreen failed to start on this
 * machine (see `boot-canary.ts`). The environment wins over everything else,
 * and the mode is only ever taken for a person at a real terminal.
 */

const OFF = new Set(['', '0', 'false', 'no', 'off'])

/** The environment's answer, or undefined when it does not say. */
export function fullscreenFromEnv(
	env: Readonly<Record<string, string | undefined>>,
): boolean | undefined {
	const raw = env.NAMZU_FULLSCREEN
	if (raw === undefined) return undefined
	return !OFF.has(raw.trim().toLowerCase())
}

export interface FullscreenWorld {
	readonly env: Readonly<Record<string, string | undefined>>
	/** `tui.fullscreen` from the user's config. */
	readonly setting?: boolean
	/** Output and input are both terminals. */
	readonly interactive: boolean
	/**
	 * A workspaces host runs this session in its own emulator and owns the
	 * alternate screen there; drawing on it twice would fight over it.
	 */
	readonly hosted: boolean
	/** An earlier fullscreen start on this machine did not finish; it yields to an explicit `tui.fullscreen: true` and to the environment. */
	readonly autoOff?: boolean
}

export function resolveFullscreen(world: FullscreenWorld): boolean {
	if (!world.interactive || world.hosted) return false
	const fromEnv = fullscreenFromEnv(world.env)
	if (fromEnv !== undefined) return fromEnv
	if (world.autoOff === true && world.setting !== true) return false
	return world.setting ?? true
}

/** What the launch resolved to, kept for `/tui` and the hints. Set once by the terminal entry. */
export interface ScreenModeNow {
	readonly fullscreen: boolean
	/** Fullscreen was left off because an earlier start on this machine failed. */
	readonly autoOff: boolean
	/** `NAMZU_FULLSCREEN` is set and decided it. */
	readonly fromEnv: boolean
}

let screenModeNow: ScreenModeNow | undefined

export function setScreenModeNow(mode: ScreenModeNow | undefined): void {
	screenModeNow = mode
}

export function getScreenModeNow(): ScreenModeNow | undefined {
	return screenModeNow
}
