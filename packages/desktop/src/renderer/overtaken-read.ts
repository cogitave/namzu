/**
 * A read of the model or engine list that a change of model overtook. The host refuses to apply an
 * answer that describes the state before the change, and says so; nothing is wrong, so the window
 * reads again once the change is done, instead of leaving the raw message on screen and the model
 * button unusable.
 */
export function isOvertakenRead(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error)
	return /conversation settings changed while loading/i.test(text)
}

/** How many times one conversation reads again before the failure is shown. */
export const OVERTAKEN_READ_LIMIT = 3
