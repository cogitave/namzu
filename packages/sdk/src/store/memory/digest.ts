import { createHash } from 'node:crypto'

import type { MemoryStore } from '../../types/memory/index.js'

/** Tag prefix both derived-memory writers (the session memory promoter and consolidation) put their content digest under. */
export const KNOWLEDGE_TAG_PREFIX = 'knowledge:'

export function knowledgeDigest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Whether `store` already holds a record carrying `digest` — archived ones
 * included, so a claim deliberately retired is not written back.
 *
 * The tag narrows the search and the metadata confirms it, because a tag is
 * free text anyone can write and the digest in metadata is what the writer
 * recorded. Best-effort: this read and the caller's create are two store
 * operations, not one, so two processes can still both write.
 */
export async function holdsKnowledgeDigest(
	store: MemoryStore,
	tags: readonly string[],
	digest: string,
	isWriter: (metadata: Record<string, unknown> | undefined) => boolean,
): Promise<boolean> {
	const existing = await store.list({
		tags: [...tags, `${KNOWLEDGE_TAG_PREFIX}${digest}`],
	})
	for (const entry of existing.entries) {
		const full = await store.get(entry.id)
		if (full?.metadata?.knowledgeDigest === digest && isWriter(full.metadata)) return true
	}
	return false
}
