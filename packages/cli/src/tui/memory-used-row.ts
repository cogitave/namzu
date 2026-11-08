/**
 * The quiet row under a message when stored memory went with it:
 * `Used 2 memories (ctrl+o to expand)`, and behind ctrl+o one line per memory
 * and how to remove one. Several recalls in one turn add to the same row.
 */

import { ageLabel, originLabel } from '../memory/manage.js'
import { EXPAND_HINT } from './truncation.js'

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

export interface UsedMemory {
	readonly id: string
	readonly name?: string
	readonly title: string
	readonly origin: 'operator' | 'model' | 'derived'
	readonly updatedAt: number
}

export interface MemoryUsedRow {
	readonly content: string
	readonly detail: readonly string[]
	readonly hint: string
}

/** The memories of `added` that `held` does not carry yet, in order. */
export function mergeUsedMemories(
	held: readonly UsedMemory[],
	added: readonly UsedMemory[],
): readonly UsedMemory[] {
	const seen = new Set(held.map((memory) => `${memory.id}@${memory.updatedAt}`))
	const out = [...held]
	for (const memory of added) {
		const key = `${memory.id}@${memory.updatedAt}`
		if (seen.has(key)) continue
		seen.add(key)
		out.push(memory)
	}
	return out
}

export function memoryUsedRow(
	memories: readonly UsedMemory[],
	now: number = Date.now(),
): MemoryUsedRow | undefined {
	const first = memories[0]
	if (!first) return undefined
	const count = memories.length
	return {
		content: `Used ${count} ${count === 1 ? 'memory' : 'memories'}`,
		detail: [
			...memories.map(
				(memory) =>
					`${oneLine(memory.title.trim() || memory.name || memory.id)} · ${originLabel(memory.origin)} · ${ageLabel(memory.updatedAt, now)}`,
			),
			`/memory delete ${first.name ?? first.id} removes one.`,
		],
		hint: EXPAND_HINT,
	}
}
