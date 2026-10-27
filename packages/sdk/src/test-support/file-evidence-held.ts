import { type Message, turnContextEntries } from '../types/message/index.js'

/**
 * The file entries a request's history holds, as the model reads them: the
 * recorded file-evidence entries replayed in order, an entry for a path
 * replacing the earlier one and a path under "No longer holds" dropped.
 * Undefined when none holds.
 */
export function heldFileEvidence(messages: readonly Message[] | undefined): unknown[] | undefined {
	const held = new Map<string, unknown>()
	for (const entry of turnContextEntries(messages ?? [], 'file-evidence')) {
		for (const line of entry.split('\n')) {
			if (line.startsWith('No longer holds: ')) {
				for (const path of JSON.parse(line.slice('No longer holds: '.length)) as string[])
					held.delete(path)
			} else if (line.startsWith('[')) {
				for (const item of JSON.parse(line) as { path: string }[]) held.set(item.path, item)
			}
		}
	}
	return held.size > 0 ? [...held.values()] : undefined
}

/** The recorded file-evidence entries of a history, oldest first. */
export function fileEvidenceEntries(messages: readonly Message[] | undefined): readonly string[] {
	return turnContextEntries(messages ?? [], 'file-evidence')
}
