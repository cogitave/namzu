import { isMemoryName } from '../../store/memory/naming.js'
import type { MemoryId } from '../../types/ids/index.js'
import type { MemoryIndexEntry, MemoryStore } from '../../types/memory/index.js'
import { asMemoryId, isEntityId } from '../../utils/id.js'

/** Every record, archived included, for resolving names. One store read. */
export async function allMemoryEntries(store: MemoryStore): Promise<readonly MemoryIndexEntry[]> {
	return (await store.list({})).entries
}

export type MemoryReference =
	| {
			readonly found: true
			readonly id: MemoryId
			/** The listing read to resolve a name, reused by a caller that needs it. */
			readonly entries?: readonly MemoryIndexEntry[]
	  }
	| { readonly found: false; readonly name: string }

/**
 * What a model-authored `id` refers to: a UUID is taken as an id, a memory
 * name — what the prompt's index shows — is looked up through the store's own
 * listing, never used as a key. Anything else goes through `asMemoryId`, which
 * refuses it.
 */
export async function resolveMemoryReference(
	store: MemoryStore,
	reference: string,
): Promise<MemoryReference> {
	if (isEntityId(reference, 'memory')) return { found: true, id: asMemoryId(reference) }
	if (isMemoryName(reference)) {
		const entries = await allMemoryEntries(store)
		const named = entries.find((entry) => entry.name === reference)
		return named ? { found: true, id: named.id, entries } : { found: false, name: reference }
	}
	return { found: true, id: asMemoryId(reference) }
}
