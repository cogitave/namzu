/**
 * Whether Ink should draw live. Ink's own default is "not in CI and stdout is a TTY", where "in CI"
 * is any CI marker in the environment (`is-in-ci`). A person whose shell exports `CI` (a dev
 * container, a terminal tab that inherited it) would then see a blank screen until exit, because
 * Ink writes only the last frame when it believes it is not interactive. The terminal app is only
 * ever started for a person at a terminal, so when both ends are one, the answer is yes whatever the
 * environment says. Only Ink's decision is overridden: `process.env` is left untouched, so the shell
 * commands the agent runs still see the same `CI`.
 *
 * Returns an empty object otherwise, which keeps Ink's own detection (today's behaviour).
 */
export function liveRenderOption(
	stdout: { readonly isTTY?: boolean },
	input: { readonly isTTY?: boolean },
	inputIsConsole: boolean,
): { readonly interactive?: true } {
	return stdout.isTTY === true && (input.isTTY === true || inputIsConsole)
		? { interactive: true }
		: {}
}
