import { resolve } from 'node:path'
import { isClearedToolResult } from '../../compaction/tool-result-editing.js'
import { fingerprintContent } from '../../tools/builtins/content-fingerprint.js'
import { predictReplayLength, replayEditCall } from '../../tools/builtins/edit-apply.js'
import { EditTool } from '../../tools/builtins/edit.js'
import { WriteFileTool } from '../../tools/builtins/write-file.js'
import type { Message, ToolCall } from '../../types/message/index.js'
import type { FileReadTracker } from '../../types/tool/index.js'

/**
 * Edit CALLS one chain may carry before the path is withheld.
 *
 * On calls rather than replacements because the bound is on replay work, and
 * an `edits: [...]` batch is one pass over the content however many hunks it
 * holds. Eight is generous for the shape this exists for — a file written and
 * then refined within a turn — and short enough that the whole request's
 * replay stays a rounding error beside the model call it rides on.
 */
const MAX_EDIT_CALLS = 8

/**
 * Content this projection may materialise across every path in one request.
 *
 * Counted cumulatively in UTF-16 units — the measure the caps above and the
 * step-context budget already use — and charged for the write body each chain
 * starts from as well as every intermediate body, because those are the
 * strings actually built. Each hop is charged against a length worked out from
 * its operations BEFORE it is replayed, and for a batch that length covers the
 * largest string the batch would build rather than the body it ends on — so a
 * request whose history is full of long chains this projection is going to
 * refuse anyway cannot make it slow proving that. A refusal is charged
 * nothing: the body was never built, and the paths after it keep their room.
 */
const MAX_REPLAYED_UNITS = 256 * 1024

interface FileEvidence {
	readonly path: string
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
	const calls = new Map<string, ToolCall | null>()
	const results = new Map<string, Message | null>()
	for (const message of messages) {
		if (message.role === 'assistant') {
			for (const call of message.toolCalls ?? []) {
				calls.set(call.id, calls.has(call.id) ? null : call)
			}
		} else if (message.role === 'tool') {
			results.set(message.toolCallId, results.has(message.toolCallId) ? null : message)
		}
	}
	const keyOf = (path: string) => (sandboxed ? path : resolve(workingDirectory, path))
	const history = { calls, results, keyOf }
	const budget = { remaining: MAX_REPLAYED_UNITS }
	const files = new Map<string, FileEvidence>()
	for (const [id, call] of calls) {
		const name = call?.function.name
		if (name !== 'write' && name !== 'edit') continue
		const visible = visibleCall(id, call, results.get(id), name)
		if (!visible) continue
		try {
			const admitted =
				name === 'write'
					? writeEvidence(id, visible, tracker, history)
					: chainEvidence(id, visible, tracker, history, budget)
			if (!admitted) continue
			files.delete(admitted.key)
			files.set(admitted.key, admitted.evidence)
			if (files.size > 6) files.delete(files.keys().next().value as string)
		} catch {
			// Malformed retained inputs, a replay that no longer applies, or a
			// custom tracker cannot establish evidence.
		}
	}
	if (files.size === 0) return
	return `Visible file evidence (this request only): each entry's current body is the complete body in the named successful write call, with the edit calls in editsInCalls — when present — applied in that order. This runtime performed that reconstruction and checked it against its own file observation; it is not a derivation left to you. Reuse the body for a targeted edit; a read solely to recall it is unnecessary. This is NOT a fresh disk check. Built-in edit/write still compare the disk body at mutation admission and refuse observed drift; on refusal inspect the current file and replan. Missing entries establish nothing.\n${JSON.stringify([...files.values()])}`
}

interface VisibleHistory {
	readonly calls: Map<string, ToolCall | null>
	readonly results: Map<string, Message | null>
	readonly keyOf: (path: string) => string
}

/**
 * The visibility every hop must pass, write or edit, root or tip.
 *
 * One function because a middle hop is not a lesser claim than the last one.
 * A chain whose second edit was cleared by compaction, or came back an error,
 * or arrived truncated, reconstructs nothing at all — so the whole path is
 * withheld rather than emitted as the part still visible, which would name a
 * body the model cannot rebuild.
 */
function visibleCall(
	id: string,
	call: ToolCall | null | undefined,
	receipt: Message | null | undefined,
	name: 'write' | 'edit',
): ToolCall | undefined {
	if (
		!call ||
		call.function.name !== name ||
		call.metadata?.inputTruncated ||
		call.function.arguments.length > 32_000 ||
		id.length > 256 ||
		!receipt ||
		receipt.role !== 'tool' ||
		receipt.isError ||
		typeof receipt.content !== 'string' ||
		isClearedToolResult(receipt.content)
	)
		return undefined
	return call
}

/** A full body that arrived whole in one call and is still the file's body. */
function writeEvidence(
	id: string,
	call: ToolCall,
	tracker: FileReadTracker,
	history: VisibleHistory,
): { key: string; evidence: FileEvidence } | undefined {
	const input = WriteFileTool.inputSchema.safeParse(JSON.parse(call.function.arguments))
	if (!input.success || input.data.path.length > 512) return
	const body = input.data.content ?? input.data.newStr
	if (typeof body !== 'string') return
	const key = history.keyOf(input.data.path)
	if (knownStale(tracker, key)) return
	const fingerprint = fingerprintContent(body)
	if (tracker.writeCallId?.(key) !== id || tracker.fingerprint?.(key) !== fingerprint) return
	return {
		key,
		evidence: { path: input.data.path, bodyInCall: id, observedFingerprint: fingerprint },
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
	call: ToolCall,
	tracker: FileReadTracker,
	history: VisibleHistory,
	budget: { remaining: number },
): { key: string; evidence: FileEvidence } | undefined {
	const tip = EditTool.inputSchema.safeParse(JSON.parse(call.function.arguments))
	if (!tip.success) return
	// No length bound on this path, unlike the root's below. The root's is the
	// spelling the entry goes out with; every hop's is held to the key it
	// resolves to instead, which is the root's own bounded path.
	const key = history.keyOf(tip.data.path)
	if (knownStale(tracker, key)) return
	const chain = tracker.editChain?.(key)
	const observed = tracker.fingerprint?.(key)
	if (!chain || observed === undefined || chain.editCallIds.at(-1) !== id) return
	// The call bound before the walk, the unit bound before each hop it pays
	// for. Neither is measured by doing the work it exists to refuse.
	if (chain.editCallIds.length > MAX_EDIT_CALLS) return
	const rootId = chain.rootWriteCallId
	const root = visibleCall(rootId, history.calls.get(rootId), history.results.get(rootId), 'write')
	if (!root) return
	const rootInput = WriteFileTool.inputSchema.safeParse(JSON.parse(root.function.arguments))
	if (!rootInput.success || rootInput.data.path.length > 512) return
	const body = rootInput.data.content ?? rootInput.data.newStr
	// A root naming a different file is an ambiguity, not a base: the ledger
	// and the visible call disagree about what was written where.
	if (typeof body !== 'string' || history.keyOf(rootInput.data.path) !== key) return
	let content = body
	if (!spend(budget, content.length)) return
	for (const editId of chain.editCallIds) {
		const hop = visibleCall(editId, history.calls.get(editId), history.results.get(editId), 'edit')
		if (!hop) return
		const input =
			editId === id ? tip : EditTool.inputSchema.safeParse(JSON.parse(hop.function.arguments))
		if (!input.success || history.keyOf(input.data.path) !== key) return
		// Charged on what this hop is going to build, read off its own
		// operations rather than found by running them — a hop over the ceiling
		// has to be refused before it is built, or the bound is measured by
		// doing the thing it bounds. Exact for the single-operation shape; for a
		// batch it pays for the largest intermediate the fold would materialise,
		// so a batch that grows the body and then cuts it back is charged for
		// what it built rather than for what it ended on.
		const predicted = predictReplayLength(content, input.data, budget.remaining)
		if (!spend(budget, predicted)) return
		// Throws on a shape or an old_string that no longer applies, which the
		// caller treats as "this path establishes nothing".
		content = replayEditCall(content, input.data).content
		// The prediction bounds the fold from above, so this is a backstop for a
		// bug in it rather than a shape that reaches here. Charging the overrun
		// before withholding keeps a broken bound from funding the paths behind
		// this one.
		if (content.length > predicted) {
			budget.remaining = Math.max(budget.remaining - (content.length - predicted), 0)
			return
		}
	}
	if (fingerprintContent(content) !== observed) return
	return {
		key,
		evidence: {
			path: rootInput.data.path,
			bodyInCall: rootId,
			editsInCalls: [...chain.editCallIds],
			observedFingerprint: observed,
		},
	}
}

/**
 * Charge one body against the request's replay allowance.
 *
 * Checked before it is taken, so a refusal costs nothing. Deducting first and
 * reporting afterwards left the allowance negative, and one oversized path
 * then refused every admissible path behind it in the same request.
 */
function spend(budget: { remaining: number }, units: number): boolean {
	if (units > budget.remaining) return false
	budget.remaining -= units
	return true
}

/**
 * Whether a refused mutation has reported this path stale since the ledger
 * last observed it.
 *
 * That refusal read the real file to make its comparison, so the ledger knows
 * its body is behind disk without this projection touching the filesystem.
 * The reconstruction would still be a body the model can rebuild — but not the
 * FILE's body, which is what an entry claims. Withheld until a real
 * observation re-baselines the ledger, which is also what clears the flag.
 */
function knownStale(tracker: FileReadTracker, key: string): boolean {
	return tracker.driftObserved?.(key) === true
}
