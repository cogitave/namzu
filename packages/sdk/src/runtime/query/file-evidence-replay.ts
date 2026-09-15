import { resolve } from 'node:path'
import { isClearedToolResult } from '../../compaction/tool-result-editing.js'
import { replayEditCallWithin } from '../../tools/builtins/edit-apply.js'
import { EditTool } from '../../tools/builtins/edit.js'
import { WriteFileTool } from '../../tools/builtins/write-file.js'
import type { Message, ToolCall } from '../../types/message/index.js'
import type { FileReadTracker } from '../../types/tool/index.js'

/**
 * Reconstructing a file's body from calls the conversation can still see.
 *
 * One module because two callers need the same answer and must not each have
 * their own idea of it: the derived work context asks "is this ledger entry's
 * body one the model can rebuild from what is in front of it?", and the resume
 * seed asks "which of these ledger entries can be rebuilt at all?". A
 * predicate that admitted a hop in one and refused it in the other would mean
 * a path referenced as evidence that the ledger never witnessed, or the
 * reverse. Everything below is a function of the messages, the ledger and the
 * bounds — there is no filesystem access anywhere in this file.
 */

/**
 * Edit CALLS one chain may carry before the path is withheld.
 *
 * On calls rather than replacements because the bound is on replay work, and
 * an `edits: [...]` batch is one pass over the content however many hunks it
 * holds. Eight is generous for the shape this exists for — a file written and
 * then refined within a turn — and short enough that the whole request's
 * replay stays a rounding error beside the model call it rides on.
 */
export const MAX_EDIT_CALLS = 8

/**
 * Content a replay may materialise across every path in one pass.
 *
 * Counted cumulatively in UTF-16 units — the measure the caps below and the
 * step-context budget already use — and charged for the write body each chain
 * starts from as well as every body an edit builds on top of it, because those
 * are the strings actually built. Each operation is measured exactly against
 * the content it is about to be applied to and refused before it is built, so
 * a pass whose history is full of long chains it is going to refuse anyway
 * cannot make itself slow proving that. A refusal is charged nothing: the body
 * was never built, and the paths after it keep their room.
 */
export const MAX_REPLAYED_UNITS = 256 * 1024

/** Arguments longer than a real tool call carries; past this the call is not read. */
const MAX_ARGUMENT_UNITS = 32_000

/** Call ids longer than any provider mints. */
const MAX_CALL_ID_UNITS = 256

/** Path lengths a `write` entry may go out with. */
const MAX_PATH_UNITS = 512

/** The calls and receipts of one conversation, indexed by call id. */
export interface VisibleHistory {
	/** `null` where an id was claimed by more than one assistant call. */
	readonly calls: ReadonlyMap<string, ToolCall | null>
	/** `null` where an id was answered more than once. */
	readonly results: ReadonlyMap<string, Message | null>
	/** The ledger key a tool-call path resolves to. */
	readonly keyOf: (path: string) => string
}

/**
 * Index a transcript once, so every lookup below is a map hit.
 *
 * An id claimed twice, or answered twice, indexes to `null` rather than to
 * whichever message came last: two calls wearing one id is an ambiguity, and
 * resolving it by position would let the second silently vouch for the first.
 */
export function indexVisibleHistory(
	messages: readonly Message[],
	workingDirectory: string,
	sandboxed: boolean,
): VisibleHistory {
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
	return {
		calls,
		results,
		keyOf: (path: string) => (sandboxed ? path : resolve(workingDirectory, path)),
	}
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
export function visibleCall(
	history: VisibleHistory,
	id: string,
	name: 'write' | 'edit',
): ToolCall | undefined {
	const call = history.calls.get(id)
	const receipt = history.results.get(id)
	if (
		!call ||
		call.function.name !== name ||
		call.metadata?.inputTruncated ||
		call.function.arguments.length > MAX_ARGUMENT_UNITS ||
		id.length > MAX_CALL_ID_UNITS ||
		!receipt ||
		receipt.role !== 'tool' ||
		receipt.isError ||
		typeof receipt.content !== 'string' ||
		isClearedToolResult(receipt.content)
	)
		return undefined
	return call
}

/** A full body that arrived whole in one visible call. */
export function visibleWrite(
	history: VisibleHistory,
	id: string,
): { readonly path: string; readonly key: string; readonly body: string } | undefined {
	const call = visibleCall(history, id, 'write')
	if (!call) return
	const input = WriteFileTool.inputSchema.safeParse(JSON.parse(call.function.arguments))
	if (!input.success || input.data.path.length > MAX_PATH_UNITS) return
	const body = input.data.content ?? input.data.newStr
	if (typeof body !== 'string') return
	return { path: input.data.path, key: history.keyOf(input.data.path), body }
}

/**
 * One visible edit call's arguments, ready to replay.
 *
 * No length bound on the path here, unlike the write above. A write's path is
 * the spelling an entry goes out with; an edit is held to the KEY it resolves
 * to, which its chain's root has already been bounded on.
 */
export function visibleEdit(
	history: VisibleHistory,
	id: string,
): { readonly key: string; readonly input: unknown } | undefined {
	const call = visibleCall(history, id, 'edit')
	if (!call) return
	const input = EditTool.inputSchema.safeParse(JSON.parse(call.function.arguments))
	if (!input.success) return
	return { key: history.keyOf(input.data.path), input: input.data }
}

/** Room left for content this pass may still materialise. */
export interface ReplayBudget {
	remaining: number
}

export function createReplayBudget(units: number = MAX_REPLAYED_UNITS): ReplayBudget {
	return { remaining: units }
}

/**
 * Charge one body against the pass's replay allowance.
 *
 * Checked before it is taken, so a refusal costs nothing. Deducting first and
 * reporting afterwards left the allowance negative, and one oversized path
 * then refused every admissible path behind it in the same pass.
 */
export function spend(budget: ReplayBudget, units: number): boolean {
	if (units > budget.remaining) return false
	budget.remaining -= units
	return true
}

/**
 * Replay one edit call onto the body in hand, within what the budget has left.
 *
 * `undefined` for a hop the budget turns away and for one that no longer
 * applies, because both mean the same thing to every caller here: this path
 * reconstructs nothing. The charge is settled either way — what the attempt
 * built, it built — and for a hop refused at its first operation that charge
 * is zero.
 */
export function replayHop(
	content: string,
	input: unknown,
	budget: ReplayBudget,
): string | undefined {
	const replay = replayEditCallWithin(content, input, budget.remaining)
	budget.remaining = Math.max(budget.remaining - replay.charged, 0)
	return replay.outcome === 'replayed' ? replay.content : undefined
}

/**
 * Whether a refused mutation has reported this path stale since the ledger
 * last observed it.
 *
 * That refusal read the real file to make its comparison, so the ledger knows
 * its body is behind disk without a consumer here touching the filesystem.
 * The reconstruction would still be a body the model can rebuild — but not the
 * FILE's body, which is what an entry claims. Withheld until a real
 * observation re-baselines the ledger, which is also what clears the flag.
 */
export function knownStale(tracker: FileReadTracker, key: string): boolean {
	return tracker.driftObserved?.(key) === true
}
