import type { SessionId } from '../ids/index.js'

/**
 * Parent/root linkage carried on every sub-session event.
 *
 * Per session-hierarchy.md §10.4 every `RunEvent` emitted from a sub-session
 * carries a {@link Lineage} so consumers can reconstruct the delegation tree
 * without walking the store. `depth` is 0 at the root session and grows by 1
 * per delegation level.
 */
export interface Lineage {
	parentSessionId: SessionId
	rootSessionId: SessionId
	depth: number
}
