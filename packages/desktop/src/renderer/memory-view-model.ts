import type {
	SavedMemory,
	SavedMemoryOrigin,
	SavedMemoryOutcome,
	SavedMemoryState,
} from '../shared/memory-protocol.js'

/** Who saved a memory, in the words the list shows. */
export function originText(origin: SavedMemoryOrigin): string {
	if (origin === 'you') return 'You saved it'
	if (origin === 'namzu') return 'Namzu saved it'
	return 'Saved from a conversation'
}

export function stateText(state: SavedMemoryState): string | undefined {
	if (state === 'set-aside') return 'Set aside'
	if (state === 'retired') return 'Retired'
	return undefined
}

/** The memories whose title or text holds every word of `query`, in the order given. */
export function filterMemories(
	memories: readonly SavedMemory[],
	query: string,
): readonly SavedMemory[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean)
	if (words.length === 0) return memories
	return memories.filter((memory) => {
		const haystack = `${memory.title} ${memory.excerpt}`.toLowerCase()
		return words.every((word) => haystack.includes(word))
	})
}

/** What a change or a delete that was refused says, in one sentence with a next step. */
export function outcomeProblem(outcome: SavedMemoryOutcome): string | undefined {
	if (outcome === 'changed')
		return 'This memory changed since you opened it. Close it and open it again.'
	if (outcome === 'gone') return 'This memory is already gone.'
	return undefined
}

export const DELETE_COPY = {
	title: 'Delete this memory?',
	description:
		'Namzu will not recall it again. A conversation that already read it keeps what it read until you clear that conversation. This cannot be undone.',
	confirm: 'Delete',
	cancel: 'Cancel',
} as const

/** Saved text that is only blanks is removed, not stored. */
export function instructionsToSave(draft: string, saved: string): string | undefined {
	if (draft === saved) return undefined
	return draft.trim() === '' ? '' : draft
}
