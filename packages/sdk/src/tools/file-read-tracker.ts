import type { FileReadTracker } from '../types/tool/index.js'
import { fingerprintContent } from './builtins/content-fingerprint.js'

/** Host-owned observation ledger. Share only across turns of the same conversation and filesystem. */
export function createFileReadTracker(): FileReadTracker {
	const paths = new Set<string>()
	const fingerprints = new Map<string, string>()
	const writes = new Map<string, string>()
	// Edits stacked on top of `writes.get(key)`, in order. Kept beside the
	// write id rather than replacing it, because the write is the base a
	// replay starts from and is still needed once edits sit on it — while
	// `writeCallId` must stop reporting it the moment the file's body stops
	// being that call's body.
	const chains = new Map<string, string[]>()
	// Reads whose receipt still holds the whole body, with the fingerprint of
	// the rendering that receipt is supposed to be. Kept apart from `writes`
	// rather than folded into it: a write's body is the model's own argument
	// and an edit can be replayed onto it, while this one exists only as text
	// formatted for a reader — so it roots nothing, and the rendering is the
	// only thing anyone is allowed to check it against.
	const reads = new Map<string, { callId: string; renderedFingerprint: string }>()
	// Paths a built-in mutation refused for drift. A flag and not an
	// observation: the refusing tool did read the disk, but it reported only
	// that what it found differs — writing a fingerprint from it would
	// re-baseline the very check that refused and let the next mutation
	// through. So this touches nothing `fingerprint`, `hasRead`, `writeCallId`,
	// `editChain` or `readWitness` answers; it says only that what this ledger
	// holds for the path is known to be behind the disk.
	const drifted = new Set<string>()
	// One observation, whatever witness the caller goes on to record against it.
	// A shared function rather than `this.recordRead`, so a destructured method
	// keeps working.
	function observe(key: string, content?: string, fullWriteCallId?: string): void {
		paths.add(key)
		drifted.delete(key)
		const next = content === undefined ? undefined : fingerprintContent(content)
		if (next === undefined || next !== fingerprints.get(key)) {
			writes.delete(key)
			chains.delete(key)
			reads.delete(key)
		}
		if (next !== undefined) fingerprints.set(key, next)
		else fingerprints.delete(key)
		if (next !== undefined && fullWriteCallId) {
			writes.set(key, fullWriteCallId)
			// A full body arrived whole in one call, so the chain is empty
			// again: nothing has been applied on top of what is now on disk.
			chains.delete(key)
		}
	}
	return {
		recordRead: observe,
		recordFullRead(key, content, callId, renderedFingerprint) {
			observe(key, content)
			// A surviving write witness outranks this one: it names a body the
			// model composed itself, and the chain machinery can replay onto it.
			// This is the same observation either way — only the witness differs.
			if (!writes.has(key)) reads.set(key, { callId, renderedFingerprint })
		},
		readWitness: (key) => reads.get(key),
		recordEdit(key, content, callId) {
			// Both conditions are about the PRE-image, not this edit. A chain
			// replays only if the content this edit ran against is itself
			// reproducible: there has to be a witnessed write underneath it, and
			// a fingerprint for what the edit actually started from — which is
			// also the value the tool's own drift check compared before writing.
			// Without both, this is an observation of a body nobody can replay.
			const chained = writes.has(key) && fingerprints.has(key) && callId.length > 0
			paths.add(key)
			drifted.delete(key)
			// Unconditionally, even where the content is unchanged: a read
			// witness points at a receipt showing the body BEFORE this edit, and
			// no chain can be rooted at a rendering to carry it forward.
			reads.delete(key)
			fingerprints.set(key, fingerprintContent(content))
			if (!chained) {
				writes.delete(key)
				chains.delete(key)
				return
			}
			chains.set(key, [...(chains.get(key) ?? []), callId])
		},
		recordDriftObserved(key) {
			drifted.add(key)
		},
		driftObserved: (key) => drifted.has(key),
		hasRead: (key) => paths.has(key),
		fingerprint: (key) => fingerprints.get(key),
		// Withheld while edits sit on top of it. A consumer that knows only this
		// method asks "is the current body the body of a call I can see?", and
		// once an edit has landed the honest answer is no.
		writeCallId: (key) => (chains.has(key) ? undefined : writes.get(key)),
		editChain: (key) => {
			const editCallIds = chains.get(key)
			const rootWriteCallId = writes.get(key)
			if (!editCallIds?.length || rootWriteCallId === undefined) return undefined
			return { rootWriteCallId, editCallIds: [...editCallIds] }
		},
	}
}
