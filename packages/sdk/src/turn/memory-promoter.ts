/**
 * Select useful extracted claims for durable recall. Exact repeated claim sets
 * are suppressed when already stored; archived claims are not reactivated.
 * This deterministic filter does not verify truth or reconcile paraphrases.
 */

import {
	KNOWLEDGE_TAG_PREFIX,
	holdsKnowledgeDigest,
	knowledgeDigest,
} from '../store/memory/digest.js'
import { SESSION_MEMORY_SOURCE } from '../store/memory/origin.js'
import type { MemoryStore } from '../types/memory/index.js'
import type { PromoteMemory, SessionMemoryCandidate } from '../types/session/memory-promotion.js'

/**
 * The categories that make a turn worth remembering.
 *
 * Ordered as they are rendered. `userRequirements` first because it is the
 * most durable of the five — a constraint the user stated outlives the turn
 * that heard it, whereas a discovery about a codebase expires when the
 * codebase moves.
 */
const KNOWLEDGE = [
	['userRequirements', 'What the user requires'],
	['decisions', 'Decisions'],
	['discoveries', 'Discoveries'],
	['failures', 'What did not work'],
	['environment', 'Environment'],
] as const satisfies readonly (readonly [keyof SessionMemoryCandidate, string])[]

/**
 * Tag every record this promoter writes, so a host can find or prune them.
 * Also its `metadata.source`, which keeps the record out of a Markdown
 * store's generated index: a record written after every turn is not one
 * anybody chose to load into every prompt.
 */
export const SESSION_MEMORY_TAG = SESSION_MEMORY_SOURCE

export interface MemoryPromoterOptions {
	/** Where records go. The same store `save_memory` writes through. */
	readonly store: MemoryStore
	/**
	 * Extra tags on every record, beyond {@link SESSION_MEMORY_TAG}.
	 *
	 * A host running several agents against one store uses this to tell whose
	 * memory is whose; without it a later search cannot.
	 */
	readonly tags?: readonly string[]
	/**
	 * Cap on entries rendered per category. Defaults to 20.
	 *
	 * The extractor already caps its lists, and this is the second cap for
	 * the same reason the first exists: a record nobody will read is a record
	 * that costs context every time it is retrieved.
	 */
	readonly maxPerCategory?: number
}

/** Everything the candidate knows, as `[heading, items]`, empties dropped. */
function knowledge(
	candidate: SessionMemoryCandidate,
	cap: number,
): readonly (readonly [string, readonly string[]])[] {
	const out: (readonly [string, readonly string[]])[] = []
	for (const [key, heading] of KNOWLEDGE) {
		const items = [
			...new Set((candidate[key] as readonly string[]).map((item) => item.trim()).filter(Boolean)),
		]
		if (items.length > 0) out.push([heading, items.slice(0, cap)])
	}
	return out
}

/** Carry actual claims into search results, with their category attribution. */
function summarize(sections: readonly (readonly [string, readonly string[]])[]): string {
	const text = sections.map(([heading, items]) => `${heading}: ${items[0]}`).join('; ')
	return text.length <= 600 ? text : `${text.slice(0, 599).replace(/[\uD800-\uDBFF]$/, '')}…`
}

function render(
	candidate: SessionMemoryCandidate,
	sections: readonly (readonly [string, readonly string[]])[],
): string {
	const body = sections.map(
		([heading, items]) => `## ${heading}\n\n${items.map((i) => `- ${i}`).join('\n')}`,
	)
	// The eviction counts, when there are any. Carried rather than hidden for
	// the reason the candidate carries them: somebody reading this record
	// should know they are reading a truncated account of the turn, not a
	// complete one.
	const evicted = Object.entries(candidate.evicted).filter(([, n]) => n > 0)
	if (evicted.length > 0) {
		body.push(
			`## Dropped during the turn\n\n${evicted
				.map(([category, n]) => `- ${category}: ${n} entr${n === 1 ? 'y' : 'ies'} evicted`)
				.join('\n')}`,
		)
	}
	if (candidate.files.length > 0) {
		body.push(`## Files touched\n\n${candidate.files.map((f) => `- ${f}`).join('\n')}`)
	}
	return `# ${candidate.task}\n\n${body.join('\n\n')}\n`
}

/**
 * Build a promoter that writes one record per turn that learned something.
 *
 * Never throws out to the runtime — but it does not swallow either: the
 * runtime already catches and logs a promoter's failure at settle, and
 * catching here as well would hide a broken store from the one place that
 * reports it.
 */
export function createMemoryPromoter(options: MemoryPromoterOptions): PromoteMemory {
	const cap = options.maxPerCategory ?? 20
	if (!Number.isSafeInteger(cap) || cap < 1)
		throw new Error('maxPerCategory must be a positive integer')
	const tags = [SESSION_MEMORY_TAG, ...(options.tags ?? [])]

	return async (candidate: SessionMemoryCandidate): Promise<void> => {
		const sections = knowledge(candidate, cap)
		// Nothing learned, nothing written. Not an empty record: a store full
		// of rows describing runs that discovered nothing is a store whose
		// search results are mostly noise, and the model reads that store.
		if (sections.length === 0) return
		const digest = knowledgeDigest(sections)
		const knowledgeTag = `${KNOWLEDGE_TAG_PREFIX}${digest}`
		// A prior exact claim, including one deliberately archived, need not be
		// saved again. This is not a cross-process uniqueness guarantee: the
		// store's individual operations are atomic, not this read/create pair.
		if (
			await holdsKnowledgeDigest(
				options.store,
				tags,
				digest,
				(metadata) => metadata?.source === SESSION_MEMORY_TAG,
			)
		)
			return

		await options.store.create({
			title: candidate.task.trim() || `Turn ${candidate.turnId}`,
			summary: summarize(sections),
			content: render(candidate, sections),
			tags: [...tags, knowledgeTag],
			type: 'project',
			format: 'markdown',
			// The turn id, so a record can be traced back to the turn that formed
			// it. Evidence rather than decoration: without it a surprising
			// memory cannot be checked against what actually happened.
			metadata: {
				sessionId: candidate.sessionId,
				turnId: candidate.turnId,
				source: SESSION_MEMORY_TAG,
				knowledgeDigest: digest,
				verification: 'unverified',
			},
		})
	}
}
