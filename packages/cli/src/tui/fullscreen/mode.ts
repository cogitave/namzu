/**
 * Whether the terminal UI draws fullscreen: on the alternate screen, with its
 * own scrolling. Opt-in. `NAMZU_FULLSCREEN` wins over `tui.fullscreen`, and the
 * mode is only ever taken for a person at a real terminal.
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
}

export function resolveFullscreen(world: FullscreenWorld): boolean {
	if (!world.interactive || world.hosted) return false
	return fullscreenFromEnv(world.env) ?? world.setting ?? false
}
