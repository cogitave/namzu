import { fingerprintContent } from '../../tools/builtins/content-fingerprint.js'
import { ReadFileTool } from '../../tools/builtins/read-file.js'
import type { Message } from '../../types/message/index.js'
import type { FileReadTracker } from '../../types/tool/index.js'
import {
	MAX_EDIT_CALLS,
	MAX_PATH_UNITS,
	MAX_WITNESSED_PATHS,
	type ReplayBudget,
	type VisibleHistory,
	createReplayBudget,
	indexVisibleHistory,
	knownStale,
	lexicalFileKeys,
	replayHop,
	spend,
	visibleCall,
	visibleEdit,
	visibleWrite,
} from './file-evidence-replay.js'

/**
 * Receipt text a read entry may point at.
 *
 * The same class of bound as the one on a write call's arguments, and set to
 * the same number for the same reason: past it the text is not read at all. A
 * bigger file is simply not admitted this way — the model re-reads it, which is
 * what it does today.
 */
const MAX_RECEIPT_UNITS = 32_000

interface FileEvidence {
	readonly path: string
	/** Absent on the write-rooted entries; `'read'` on a body that is a receipt. */
	readonly kind?: 'read'
	readonly bodyInCall: string
	readonly editsInCalls?: readonly string[]
	readonly observedFingerprint: string
}

/** Join visible call bodies, successful receipts and this executor's observation ledger. */
export function describeVisibleFileEvidence(
	messages: readonly Message[],
	tracker: FileReadTracker,
	workingDirectory: string,
	sandboxed: boolean,
): string | undefined {
	// Execution-owned witnesses survive transparent wrappers; a name alone proves nothing.
	if (!tracker.writeCallId || !tracker.fingerprint) return
	// Lexical, as this projection has always looked entries up: a spelling that
	// does not resolve to the tool's canonical key finds nothing and the path is
	// simply not admitted. Writing the ledger is the side that has to key the
	// way the tools do — see `file-evidence-seed.ts`.
	const history = indexVisibleHistory(messages, lexicalFileKeys(workingDirectory, sandboxed))
	const budget = createReplayBudget()
	const files = new Map<string, FileEvidence>()
	for (const [id, call] of history.calls) {
		const name = call?.function.name
		if (name !== 'write' && name !== 'edit' && name !== 'read') continue
		try {
			const admitted =
				name === 'write'
					? writeEvidence(id, tracker, history)
					: name === 'edit'
						? chainEvidence(id, tracker, history, budget)
						: readEvidence(id, tracker, history)
			if (!admitted) continue
			// A write-rooted entry outranks a read of the same file: it names a
			// body the model composed itself, and edits can be replayed onto it.
			// The ledger already withholds a read witness where one survives; this
			// keeps a read that ran BEFORE the write from taking the path back.
			const held = files.get(admitted.key)
			if (admitted.evidence.kind === 'read' && held && held.kind !== 'read') continue
			files.delete(admitted.key)
			files.set(admitted.key, admitted.evidence)
			if (files.size > MAX_WITNESSED_PATHS) files.delete(files.keys().next().value as string)
		} catch {
			// Malformed retained inputs or a custom tracker cannot establish evidence.
		}
	}
	if (files.size === 0) return
	return `Visible file evidence (this request only): each entry's current body is the complete body in the named successful write call, with the edit calls in editsInCalls — when present — applied in that order. An entry marked kind:"read" instead names a successful read call whose own receipt shows the file WHOLE, rendered with every line behind its own N<tab> prefix; that receipt is the body, and such an entry never carries editsInCalls. This runtime performed that reconstruction and checked it against its own file observation; it is not a derivation left to you. Reuse the body for a targeted edit; a read solely to recall it is unnecessary. This is NOT a fresh disk check, and after a resume the observation behind an entry may itself have been rebuilt from this conversation's own earlier calls rather than made while this process ran. Built-in edit/write still compare the disk body at mutation admission and refuse observed drift; on refusal inspect the current file and replan. Missing entries establish nothing.\n${JSON.stringify([...files.values()])}`
}

/** A full body that arrived whole in one call and is still the file's body. */
function writeEvidence(
	id: string,
	tracker: FileReadTracker,
	history: VisibleHistory,
): { key: string; evidence: FileEvidence } | undefined {
	const written = visibleWrite(history, id)
	if (!written || knownStale(tracker, written.key)) return
	const fingerprint = fingerprintContent(written.body)
	if (
		tracker.writeCallId?.(written.key) !== id ||
		tracker.fingerprint?.(written.key) !== fingerprint
	)
		return
	return {
		key: written.key,
		evidence: {
			path: written.path,
			bodyInCall: id,
			observedFingerprint: fingerprint,
		},
	}
}

/**
 * A full body plus the visible edits since, replayed and then checked.
 *
 * Only the chain's TIP establishes the path: a middle hop is validated as part
 * of the walk below, and admitting one on its own would claim the file stops
 * at an edit later calls have already moved past. The replay runs the same
 * apply core the tool ran at mutation time, over call arguments that are
 * already in the conversation — no filesystem read, and the result is compared
 * to the ledger's disk-derived fingerprint, never written into it.
 */
function chainEvidence(
	id: string,
	tracker: FileReadTracker,
	history: VisibleHistory,
	budget: ReplayBudget,
): { key: string; evidence: FileEvidence } | undefined {
	const tip = visibleEdit(history, id)
	if (!tip || knownStale(tracker, tip.key)) return
	const key = tip.key
	const chain = tracker.editChain?.(key)
	const observed = tracker.fingerprint?.(key)
	if (!chain || observed === undefined || chain.editCallIds.at(-1) !== id) return
	// The call bound before the walk, the unit bound before each operation it
	// pays for. Neither is measured by doing the work it exists to refuse.
	if (chain.editCallIds.length > MAX_EDIT_CALLS) return
	const rootId = chain.rootWriteCallId
	const root = visibleWrite(history, rootId)
	// A root naming a different file is an ambiguity, not a base: the ledger
	// and the visible call disagree about what was written where.
	if (!root || root.key !== key) return
	let content = root.body
	if (!spend(budget, content.length)) return
	for (const editId of chain.editCallIds) {
		const hop = editId === id ? tip : visibleEdit(history, editId)
		if (!hop || hop.key !== key) return
		// Each of this hop's operations is measured against the body it is about
		// to be applied to, charged, and only then applied — so a hop over the
		// ceiling is refused before it is built rather than after, and one that
		// fits is never turned away for a ceiling that guessed high. A hop the
		// budget refuses, or one whose anchors no longer match, reconstructs
		// nothing and withholds the whole path.
		const replayed = replayHop(content, hop.input, budget)
		if (replayed === undefined) return
		content = replayed
	}
	if (fingerprintContent(content) !== observed) return
	return {
		key,
		evidence: {
			path: root.path,
			bodyInCall: rootId,
			editsInCalls: [...chain.editCallIds],
			observedFingerprint: observed,
		},
	}
}

/**
 * A body the model can still see because a read of the whole file put it there.
 *
 * Structurally unlike the two above, and deliberately so. They name a body the
 * model itself composed, in arguments this projection can parse and replay; this
 * names a RESULT, and the only thing anyone is allowed to do with it is compare
 * it. The tool fingerprinted the exact string it emitted, and the entry is
 * admitted only while the receipt still fingerprints to that — so a receipt the
 * output budget elided or spilled, one compaction cleared, or one changed in any
 * other way withholds the path rather than pointing the model at a body that is
 * no longer in front of it. Nothing here undoes the line numbering to recover
 * text: the numbering is what makes the comparison conclusive, not an encoding
 * to be reversed.
 *
 * No chain, ever. A read roots nothing, so an entry here is the file as that one
 * call showed it, and the ledger drops the witness the moment an edit lands.
 */
function readEvidence(
	id: string,
	tracker: FileReadTracker,
	history: VisibleHistory,
): { key: string; evidence: FileEvidence } | undefined {
	if (!tracker.readWitness) return
	const call = visibleCall(history, id, 'read')
	const shown = history.results.get(id)?.content
	if (!call || typeof shown !== 'string' || shown.length > MAX_RECEIPT_UNITS) return
	const input = ReadFileTool.inputSchema.safeParse(JSON.parse(call.function.arguments))
	if (!input.success || input.data.path.length > MAX_PATH_UNITS) return
	const key = history.keyOf(input.data.path)
	if (key === undefined || knownStale(tracker, key)) return
	const witness = tracker.readWitness(key)
	const observed = tracker.fingerprint?.(key)
	if (!witness || witness.callId !== id || observed === undefined) return
	if (fingerprintContent(shown) !== witness.renderedFingerprint) return
	return {
		key,
		evidence: {
			path: input.data.path,
			kind: 'read',
			bodyInCall: id,
			observedFingerprint: observed,
		},
	}
}
