/**
 * What the person sees and presses to move a running shell command to the
 * background: the dim hint under the command, and the chord that does it.
 */

/**
 * The hint under a shell command that has run long enough to be moved.
 * Inside tmux the multiplexer takes the first Ctrl+B for itself, so the key is
 * pressed twice and the hint says so.
 */
export function backgroundHint(env: NodeJS.ProcessEnv = process.env): string {
	const inTmux = env.TMUX !== undefined && env.TMUX !== ''
	return inTmux ? '(ctrl+b ctrl+b (twice) to run in background)' : '(ctrl+b to run in background)'
}

/** Whether a key press is the chord that moves a running command to the background. */
export function isBackgroundChord(input: string, key: { readonly ctrl: boolean }): boolean {
	return key.ctrl && input === 'b'
}
