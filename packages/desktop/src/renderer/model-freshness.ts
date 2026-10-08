export const NEW_MODEL_DAYS = 7
const NEW_MODEL_MS = NEW_MODEL_DAYS * 24 * 60 * 60 * 1000

/**
 * A model is new for a week after main first saw it in a refreshed list. A model with no
 * `firstSeen` was there from the first stored list, so nothing marks it.
 */
export function isNewModel(firstSeen: string | undefined, now: number): boolean {
	if (firstSeen === undefined) return false
	const seen = Date.parse(firstSeen)
	// A clock set back a little leaves a future stamp that still counts as new; one more than
	// a window ahead is a bad clock, and must not keep the chip for years.
	return Number.isFinite(seen) && Math.abs(now - seen) < NEW_MODEL_MS
}
