/** Only the live guest surface owns computer input, never a host chat or popup. */
export function computerSurfaceOwnsFocus(
	focused: { closest(selector: string): unknown } | null,
): boolean {
	return Boolean(focused?.closest('.pal-computer-screen'))
}

/** Pending input retired by a view/focus change is an expected cancellation. */
export class ComputerInputRetiredError extends Error {
	constructor() {
		super('Computer input belongs to an earlier view or focus.')
		this.name = 'ComputerInputRetiredError'
	}
}
