/**
 * Select useful extracted claims for durable recall. Exact repeated claim sets
 * are suppressed when already stored; archived claims are not reactivated.
 * This deterministic filter does not verify truth or reconcile paraphrases.
 */

import { createHash } from 'node:crypto'
import type { MemoryStore } from '../types/memory/index.js'
import type { PromoteMemory, RunMemoryCandidate } from '../types/run/memory-promotion.js'

/**
 * The categories that make a run worth remembering.
 *
 * Ordered as they are rendered. `userRequirements` first because it is the
 * most durable of the five — a constraint the user stated outlives the run
 * that heard it, whereas a discovery about a codebase expires when the
 * codebase moves.
 */
const KNOWLEDGE = [
	['userRequirements', 'What the user requires'],
	['decisions', 'Decisions'],
	['discoveries', 'Discoveries'],
	['failures', 'What did not work'],
	['environment', 'Environment'],
] as const satisfies readonly (readonly [keyof RunMemoryCandidate, string])[]

/** Tag every record this promoter writes, so a host can find or prune them. */
export const RUN_MEMORY_TAG = 'run-memory'

export interface MemoryPromoterOptions {
	/** Where records go. The same store `save_memory` writes through. */
	readonly store: MemoryStore
	/**
	 * Extra tags on every record, beyond {@link RUN_MEMORY_TAG}.
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
	candidate: RunMemoryCandidate,
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
	candidate: RunMemoryCandidate,
	sections: readonly (readonly [string, readonly string[]])[],
): string {
	const body = sections.map(
		([heading, items]) => `## ${heading}\n\n${items.map((i) => `- ${i}`).join('\n')}`,
	)
	// The eviction counts, when there are any. Carried rather than hidden for
	// the reason the candidate carries them: somebody reading this record
	// should know they are reading a truncated account of the run, not a
	// complete one.
	const evicted = Object.entries(candidate.evicted).filter(([, n]) => n > 0)
	if (evicted.length > 0) {
		body.push(
			`## Dropped during the run\n\n${evicted
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
 * Build a promoter that writes one record per run that learned something.
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
	const tags = [RUN_MEMORY_TAG, ...(options.tags ?? [])]

	return async (candidate: RunMemoryCandidate): Promise<void> => {
		const sections = knowledge(candidate, cap)
		// Nothing learned, nothing written. Not an empty record: a store full
		// of rows describing runs that discovered nothing is a store whose
		// search results are mostly noise, and the model reads that store.
		if (sections.length === 0) return
		const digest = createHash('sha256').update(JSON.stringify(sections)).digest('hex')
		const knowledgeTag = `knowledge:${digest}`
		// A prior exact claim, including one deliberately archived, need not be
		// saved again. This is not a cross-process uniqueness guarantee: the
		// store's individual operations are atomic, not this read/create pair.
		const existing = await options.store.list({
			tags: [...tags, knowledgeTag],
		})
		for (const entry of existing.entries) {
			const full = await options.store.get(entry.id)
			if (full?.metadata?.source === RUN_MEMORY_TAG && full.metadata.knowledgeDigest === digest)
				return
		}

		await options.store.create({
			title: candidate.task.trim() || `Run ${candidate.runId}`,
			summary: summarize(sections),
			content: render(candidate, sections),
			tags: [...tags, knowledgeTag],
			format: 'markdown',
			// The run id, so a record can be traced back to the run that formed
			// it. Evidence rather than decoration: without it a surprising
			// memory cannot be checked against what actually happened.
			metadata: {
				runId: candidate.runId,
				source: RUN_MEMORY_TAG,
				knowledgeDigest: digest,
				verification: 'unverified',
			},
		})
	}
}
