import type { ModelVersion } from '@namzu/sdk'

/**
 * A rule that holds for one model family from one version onward.
 *
 * Inclusive and open-ended on purpose. The capability questions this package
 * asks of a model id — can thinking be switched off, will a forced tool choice
 * be taken — have each changed in one direction within a family, and at a
 * MINOR version: `claude-opus-5` can switch thinking off and `claude-opus-5-5`
 * cannot. A list of exact ids needs a row per release and fails open on the
 * next one; a floor needs a row per family per change, and the next release
 * in a family that has crossed inherits the answer instead of falling through
 * to a default that sends a field the wire refuses.
 */
export interface VersionFloor {
	readonly family: string
	readonly major: number
	readonly minor: number
}

/** Whether `version` is at or above the floor listed for its own family. */
export function reachesFloor(version: ModelVersion, floors: readonly VersionFloor[]): boolean {
	return floors.some(
		(floor) =>
			floor.family === version.family &&
			(version.major > floor.major ||
				(version.major === floor.major && version.minor >= floor.minor)),
	)
}
