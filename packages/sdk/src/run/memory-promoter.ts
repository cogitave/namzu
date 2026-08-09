/**
 * The default {@link PromoteMemory}: write what a run learned into a
 * {@link MemoryStore}, or write nothing at all.
 *
 * `promoteMemory` is called once at settle with the compaction extractor's
 * already-structured output — decisions, discoveries, user requirements,
 * failures, environment facts — and **nothing shipped supplied the hook**.
 * So the structure the compaction pass had spent tokens producing was
 * serialized into one system message and dropped on the floor when the run
 * ended, exactly as its own module comment says. This is the supplier, and
 * it is mostly a filter: the hard part — extracting facts from a transcript
 * — already happened.
 *
 * ## The filter, which is the only decision here
 *
 * **A run that learned nothing must leave nothing.** Not an empty record,
 * not a record whose body says "no decisions" — nothing. A promoter that
 * wrote a row per run would fill the store with the runs least worth
 * remembering, and `search_memory` would then return them: the model reads
 * that store on later runs, so noise here is not merely wasted disk, it is
 * context spent on a run that did nothing.
 *
 * What counts as having learned something is the five KNOWLEDGE categories —
 * decisions, discoveries, user requirements, failures, environment. Not
 * `task`, which every run has because it is the prompt restated. Not
 * `files`, which every run that opened anything has, and which says what was
 * touched rather than what was learned. A run whose only trace is "it read
 * six files" is the exact record this filter exists to refuse.
 *
 * ## What it does NOT do
 *
 * Deduplicate against what is already stored, merge with a previous run's
 * record, or expire anything. Each is a policy with real trade-offs and a
 * host that wants one owns it — `promoteMemory` is a callback precisely so
 * that the runtime does not decide this. This is the obvious default, not
 * the only possible one.
 */

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
		const items = candidate[key] as readonly string[]
		if (items.length > 0) out.push([heading, items.slice(0, cap)])
	}
	return out
}

/** A one-line summary naming what kind of knowledge the record holds. */
function summarize(sections: readonly (readonly [string, readonly string[]])[]): string {
	return sections.map(([heading, items]) => `${heading.toLowerCase()} (${items.length})`).join(', ')
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
	const tags = [RUN_MEMORY_TAG, ...(options.tags ?? [])]

	return async (candidate: RunMemoryCandidate): Promise<void> => {
		const sections = knowledge(candidate, cap)
		// Nothing learned, nothing written. Not an empty record: a store full
		// of rows describing runs that discovered nothing is a store whose
		// search results are mostly noise, and the model reads that store.
		if (sections.length === 0) return

		await options.store.create({
			title: candidate.task.trim() || `Run ${candidate.runId}`,
			summary: summarize(sections),
			content: render(candidate, sections),
			tags,
			format: 'markdown',
			// The run id, so a record can be traced back to the run that formed
			// it. Evidence rather than decoration: without it a surprising
			// memory cannot be checked against what actually happened.
			metadata: { runId: candidate.runId, source: RUN_MEMORY_TAG },
		})
	}
}
