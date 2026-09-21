/**
 * Who wrote a memory, read from the metadata its writer stamps.
 *
 * The generated index a host loads into every prompt lists what someone chose
 * to remember. A record the runtime derived on its own — the run promoter's
 * account of a run, a consolidation of a run's working state — is written
 * after almost every run; listing it would change the system prompt nearly
 * every turn, invalidating the prompt cache from there on, and would push the
 * operator's own memories out of a capped index. Such records stay in the
 * store, reachable through recall and search, and never enter the index.
 */

/** `metadata.source` of a record the run promoter writes. */
export const RUN_MEMORY_SOURCE = 'run-memory'
/** `metadata.kind` of a record consolidation writes. */
export const CONSOLIDATION_KIND = 'consolidation'
/** `metadata.source` of a record the model saved with `save_memory`. */
export const AGENT_MEMORY_SOURCE = 'agent-memory'

/**
 * - `derived` — written by the runtime, not chosen by anyone: never indexed.
 * - `model` — saved by the model with `save_memory`.
 * - `operator` — everything else: a note, a hand-written file, an import.
 */
export type MemoryOrigin = 'derived' | 'model' | 'operator'

export function memoryOrigin(
	metadata: Readonly<Record<string, unknown>> | undefined,
): MemoryOrigin {
	if (metadata?.source === RUN_MEMORY_SOURCE || metadata?.kind === CONSOLIDATION_KIND) {
		return 'derived'
	}
	if (metadata?.source === AGENT_MEMORY_SOURCE) return 'model'
	return 'operator'
}
