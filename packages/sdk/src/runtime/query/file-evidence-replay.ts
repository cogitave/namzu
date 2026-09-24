import { resolve } from 'node:path'
import { isClearedToolResult } from '../../compaction/tool-result-editing.js'
import { replayEditCallWithin } from '../../tools/builtins/edit-apply.js'
import { EditTool } from '../../tools/builtins/edit.js'
import { ReadFileTool } from '../../tools/builtins/read-file.js'
import {
	type ReadWindowRequest,
	renderNumberedRead,
	resolveReadWindow,
} from '../../tools/builtins/read-render.js'
import { WriteFileTool } from '../../tools/builtins/write-file.js'
import type { Message, ToolCall } from '../../types/message/index.js'
import type { FileReadTracker } from '../../types/tool/index.js'
import { isSkippedToolResult } from './plugin-hooks.js'

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

/**
 * Arguments longer than a real tool call carries; past this the call is not
 * read AS EVIDENCE.
 *
 * A bound on what may be BELIEVED, and on nothing else. The path such a call
 * declares is still read, under no bound at all — see {@link declaredPath} —
 * because a write too long to quote back is still a write that happened, and a
 * pass that could not say WHICH file it happened to would have to abandon every
 * other path in the conversation to stay honest.
 */
const MAX_ARGUMENT_UNITS = 32_000

/** Call ids longer than any provider mints. */
const MAX_CALL_ID_UNITS = 256

/**
 * Path lengths a `write` entry may go out with.
 *
 * Exported because `file-evidence-context.ts` puts the same bound on the
 * spelling a `read` entry emits — a read is the other thing that puts a path
 * in the work-context message, and the constant belongs to this module.
 */
export const MAX_PATH_UNITS = 512

/**
 * Arguments this module will not read as JSON at all, at any bound.
 *
 * {@link MAX_ARGUMENT_UNITS} governs what may be BELIEVED about a call, and
 * deliberately leaves attribution unbounded so that one large `write` cannot
 * cost a conversation every other witness in it. Unbounded is still not free:
 * `JSON.parse` over a multi-megabyte body is real work, and it was being done
 * up to three times for one call — once to collect the paths, once to key the
 * mutation, once to read the call as evidence. Two of those are gone: the
 * attribution answer is now memoised for the whole pass (see
 * {@link PathAttributions}), and the evidence read never reaches a call past
 * the far smaller bound above. What is left is this ceiling on the single
 * remaining parse.
 *
 * About a megabyte, some thirty times the evidence bound, because the rule is
 * that an oversize-but-ORDINARY write stays attributable — a generated file, a
 * bundled config, a long document — while the pathological input is refused. A
 * call past it is attributable to nothing, and the walk treats it exactly as
 * it treats one that names no `path`: there is no key to withdraw, so the
 * whole pass is abandoned and the conversation keeps the empty ledger a resume
 * has always started from.
 */
const MAX_ATTRIBUTION_UNITS = 1024 * 1024

/**
 * One pass's answer to "which file did this call touch", memoised.
 *
 * Keyed on the call OBJECT rather than on its id: an id claimed by two calls
 * is an ambiguity this module refuses to settle by position, and settling it
 * by cache hit instead would be the same mistake wearing a different hat. A
 * `WeakMap` because the entries are worth exactly as long as the transcript
 * they describe, and the value is the declared path or `null` for a call that
 * declares none — `undefined` means only "not asked yet".
 */
export type PathAttributions = WeakMap<ToolCall, string | null>

export function createPathAttributions(): PathAttributions {
	return new WeakMap()
}

/**
 * A call's arguments as JSON, or `undefined` for arguments this module will
 * not read.
 *
 * Every `JSON.parse` of a tool call in this file goes through here, so the
 * ceiling is one rule rather than one rule per reader, and malformed input is
 * a value the callers test rather than an exception they have to be wrapped
 * against.
 */
function parseArguments(call: ToolCall): unknown {
	if (call.function.arguments.length > MAX_ATTRIBUTION_UNITS) return undefined
	try {
		return JSON.parse(call.function.arguments)
	} catch {
		return undefined
	}
}

/**
 * The ledger key a tool-call path belongs to, or `undefined` for a path this
 * pass may not key at all.
 *
 * A resolver rather than a working directory, because the two callers do not
 * key alike and must not be made to. The projection READS a ledger the tools
 * wrote and looks entries up lexically, as it always has: a spelling that does
 * not match the tool's canonical key simply finds nothing. A seed WRITES that
 * ledger, so its keys have to be the ones the tools will come looking for —
 * which means resolving a path the way `write` and `edit` resolve it, through
 * every symlink, and that is filesystem work nothing in this module is allowed
 * to do. So the caller resolves first and hands the answers in.
 */
export type FileKeyResolver = (path: string) => string | undefined

/**
 * The lexical key space: the path resolved against the working directory, or
 * the path as written when the tools address a sandbox.
 *
 * What a reader of the ledger uses. Not what a writer of it may use: see
 * {@link FileKeyResolver}.
 */
export function lexicalFileKeys(workingDirectory: string, sandboxed: boolean): FileKeyResolver {
	return (path: string) => (sandboxed ? path : resolve(workingDirectory, path))
}

/** The calls and receipts of one conversation, indexed by call id. */
export interface VisibleHistory {
	/** `null` where an id was claimed by more than one assistant call. */
	readonly calls: ReadonlyMap<string, ToolCall | null>
	/** `null` where an id was answered more than once. */
	readonly results: ReadonlyMap<string, Message | null>
	/** The ledger key a tool-call path resolves to. */
	readonly keyOf: FileKeyResolver
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
	keyOf: FileKeyResolver,
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
	return { calls, results, keyOf }
}

/**
 * Every path a replay of this history might have to key, in the order the
 * calls arrived.
 *
 * For a caller that has to resolve them before the replay can run, and only
 * for that: nothing here decides anything about a path. Empty when the history
 * holds no `write` and no `edit` call at all, because a claim is only ever made
 * by a mutation — a conversation that only read files reconstructs nothing, and
 * resolving its reads would be filesystem work with no possible result.
 *
 * Every mutation the walk can ATTRIBUTE has to appear here, the ones it will
 * refuse to reconstruct included. This used to drop a call whose arguments ran
 * past the evidence bound, so the walk reached it holding no key for its path,
 * read that as a mutation it could not attribute, and abandoned the seeding
 * entirely: one thirty-kilobyte `write` anywhere in a conversation erased every
 * witness in it. The bounds belong to what may be believed; the path is read
 * here out of the same field the walk reads it from, under no bound at all.
 */
export function collectObservedPaths(
	messages: readonly Message[],
	attributions: PathAttributions = createPathAttributions(),
): readonly string[] {
	const paths = new Set<string>()
	let mutated = false
	for (const message of messages) {
		if (message.role !== 'assistant') continue
		for (const call of message.toolCalls ?? []) {
			const name = call.function.name
			if (name !== 'write' && name !== 'edit' && name !== 'read') continue
			if (name !== 'read') mutated = true
			const path = declaredPath(call, attributions)
			if (path !== undefined) paths.add(path)
		}
	}
	return mutated ? [...paths] : []
}

/**
 * The `path` argument a tool call declares, whatever else its input holds.
 *
 * The one attribution rule, used both to collect the paths a pass must resolve
 * and to key each mutation as the walk reaches it — one function, so the two
 * can never disagree about which file a call touched, which is the disagreement
 * that turns an ordinary large write into a total loss.
 *
 * The recorded arguments and nothing else. A receipt names the path too, but it
 * names it inside a sentence a path may itself contain, in a spelling that
 * differs between the host and sandbox branches, and compaction clears receipts
 * while it never clears a call. A call whose arguments could not be read, cut
 * off mid-JSON or malformed, carries `{}` here: `function.arguments` is
 * normalized to that and the raw buffer moves to `metadata.partialArguments`,
 * which is what the model was saying rather than what ran — a
 * `repairToolCall` hook may have rewritten the arguments before execution. So
 * an unreadable call is attributable to nothing, and the walk treats it as
 * such. So is a call whose arguments run past
 * {@link MAX_ATTRIBUTION_UNITS}, which this does not read at all.
 *
 * Answered once per pass and remembered. The path collection and the walk ask
 * the same question of the same calls, and a `write` carries a whole file body
 * in the string being parsed to answer it.
 */
function declaredPath(call: ToolCall, attributions: PathAttributions): string | undefined {
	const remembered = attributions.get(call)
	if (remembered !== undefined) return remembered ?? undefined
	const parsed = parseArguments(call)
	const declared =
		typeof parsed === 'object' && parsed !== null ? (parsed as { path?: unknown }).path : undefined
	const path = typeof declared === 'string' && declared.length > 0 ? declared : null
	attributions.set(call, path)
	return path ?? undefined
}

/**
 * The visibility every hop must pass, write or edit, root or tip.
 *
 * One function because a middle hop is not a lesser claim than the last one.
 * A chain whose second edit was cleared by compaction, or came back an error,
 * or arrived with arguments that could not be read, reconstructs nothing at all — so the whole path is
 * withheld rather than emitted as the part still visible, which would name a
 * body the model cannot rebuild.
 *
 * A call a `pre_tool_use` hook SKIPPED is the one refusal that does not arrive
 * as an error. The hook declined the call; nothing failed, so the receipt is a
 * plain success carrying the sentence `plugin-hooks.ts` writes for it, and
 * reading that as a `write` would hand back a body the tool was never allowed
 * to put on disk — a fingerprint for a file that still holds whatever it held
 * before, and a spurious drift refusal on the next edit. Recognised through
 * the same function that writes the sentence, so the two cannot drift apart.
 */
export function visibleCall(
	history: VisibleHistory,
	id: string,
	name: 'write' | 'edit' | 'read',
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
		isClearedToolResult(receipt.content) ||
		isSkippedToolResult(name, receipt.content)
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
	const input = WriteFileTool.inputSchema.safeParse(parseArguments(call))
	if (!input.success || input.data.path.length > MAX_PATH_UNITS) return
	const body = input.data.content ?? input.data.newStr
	if (typeof body !== 'string') return
	const key = history.keyOf(input.data.path)
	if (key === undefined) return
	return { path: input.data.path, key, body }
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
	const input = EditTool.inputSchema.safeParse(parseArguments(call))
	if (!input.success) return
	const key = history.keyOf(input.data.path)
	if (key === undefined) return
	return { key, input: input.data }
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

/**
 * Paths one pass may hold a reconstructed body for at a time.
 *
 * The projection emits at most this many entries and keeps the most recent, so
 * a pass that tracked more would be doing work whose result is discarded.
 */
export const MAX_WITNESSED_PATHS = 6

/** What one pass of {@link replayObservationLedger} established. */
export interface LedgerReplayReport {
	/** Paths whose body was reconstructed exactly, with a fingerprint and a witness. */
	readonly pathsWitnessed: number
	/**
	 * Paths the conversation demonstrably mutated but whose body could not be
	 * rebuilt. Nothing is written to the ledger for these; see {@link commit}.
	 */
	readonly pathsSeen: number
	/**
	 * Content materialised, in UTF-16 units. Never above
	 * {@link MAX_REPLAYED_UNITS}, and non-zero even for a pass that established
	 * nothing: it reports the work done, not the work kept.
	 */
	readonly unitsReplayed: number
}

/**
 * One path's state part-way through a walk of the transcript.
 *
 * `content` is a body this pass can rebuild and is still holding; `seen` is a
 * path the conversation mutated whose current body it cannot rebuild. `seen`
 * exists so that an edit cannot stack onto a body something unseen has already
 * replaced; it reaches the ledger as nothing at all.
 */
type Claim =
	| { readonly kind: 'content'; body: string; readonly steps: LedgerStep[] }
	| { readonly kind: 'seen' }

/** A call to make against the ledger once the whole walk has stood up. */
type LedgerStep =
	| { readonly kind: 'write'; readonly body: string; readonly callId: string }
	| { readonly kind: 'edit'; readonly content: string; readonly callId: string }

/**
 * Rebuild an observation ledger from a conversation's own history.
 *
 * The ledger is process state. A resumed conversation gets a fresh empty one,
 * and until something reads a file again the runtime knows nothing about files
 * this conversation wrote in full — so the projection admits nothing and the
 * model re-reads a body already in front of it, every time a session is picked
 * back up.
 *
 * What is reconstructable here is exactly what the projection would admit, by
 * the same predicates and the same bounded replay, because both go through the
 * functions above. A `write` whose call and successful receipt are both intact
 * hands back its body and its witness; the edits on top of it are replayed
 * hop by hop and extend the chain. Anything else about a path the conversation
 * mutated — a receipt compaction cleared, a call the transcript never answered,
 * a mutation it refused, one a `pre_tool_use` hook skipped before it ever ran,
 * a hop that no longer applies, a body past the bounds, a call too long to
 * quote back — withdraws whatever this pass was holding for that path and
 * writes NOTHING for it.
 *
 * Content-backed observations only, and that is the whole of what a resume
 * restores. A path in the ledger with no fingerprint is a path `write` lets
 * through unread: the read-before-overwrite refusal is `hasRead`, and the drift
 * comparison it guards needs a body to compare. Seeding membership alone would
 * therefore admit a full overwrite of a file that changed while the session was
 * closed, with nothing checked — weaker than the empty ledger a resume used to
 * start from, which refuses that overwrite outright. So a path this pass cannot
 * rebuild is left exactly as that empty ledger leaves it, and the first real
 * read re-establishes it.
 *
 * Two things this deliberately does not do. It never reads the filesystem: a
 * fingerprint restored here is a claim derived from history, and the built-in
 * mutation checks still compare it against the real file before anything is
 * written — so a file changed while the session was closed is refused exactly
 * as it is today, and the refusal's drift flag withdraws the entry. And it
 * never recovers a body from a `read` receipt by undoing the line numbering: a
 * read's rendering is compared, whole, against a body this pass already holds,
 * and a read that cannot be matched that way withdraws the body rather than
 * supplying one.
 *
 * That first guarantee is the reason `keyOf` is a parameter. Everything written
 * here has to land on the key the mutation tools will look it up under, and on
 * a host those keys are canonical — `write` and `edit` follow every symlink
 * before they touch the ledger. Keying a seed lexically instead writes entries
 * into a key space the tools never read: the projection would then match a
 * fingerprint this pass had just written to it, and the drift refusal that is
 * supposed to withdraw the claim would land somewhere else and never reach it.
 * So the caller resolves the paths the way the tools do — see
 * `file-evidence-seed.ts` — and a path it could not resolve gets no key, which
 * makes the mutation that named it unattributable and stops the pass.
 */
export function replayObservationLedger(
	messages: readonly Message[],
	tracker: FileReadTracker,
	keyOf: FileKeyResolver,
	attributions: PathAttributions = createPathAttributions(),
): LedgerReplayReport {
	const history = indexVisibleHistory(messages, keyOf)
	const budget = createReplayBudget()
	const claims = new Map<string, Claim>()
	// The keys currently holding a body, newest last — the projection's own
	// order, so the paths this keeps are the paths it would emit.
	const withBody = new Set<string>()

	for (const message of messages) {
		if (message.role !== 'assistant') continue
		for (const call of message.toolCalls ?? []) {
			const name = call.function.name
			if (name !== 'write' && name !== 'edit' && name !== 'read') continue
			const receipt = history.results.get(call.id)
			// Two receipts wearing one call id hide which of them this call got.
			// On a mutation that is the ambiguity below, arriving from the other
			// side. On a READ it is no smaller: the receipt that was hidden could
			// be the one showing a body this walk is holding to be something else,
			// and skipping the read past would keep a claim that very observation
			// withdrew. Both get the same answer.
			if (receipt === null) return commit(tracker, new Map(), budget)
			const answered = receipt !== undefined && receipt.role === 'tool' && !receipt.isError
			if (name === 'read') {
				// A read that never came back, or came back refused, saw no body: it
				// can neither confirm what this pass holds nor contradict it. And a
				// read changes no file, so a claim left standing across one is still a
				// claim about the same bytes.
				if (answered) observeRead(history, call, claims, withBody, budget)
				continue
			}
			// One id claimed by two calls hides which of them ran. On a path this
			// pass is not holding that is merely invisible, but a mutation could
			// have replaced a body claimed somewhere else in this walk, and there
			// is no way to tell where — so the pass establishes nothing at all
			// rather than carry a body something unseen may have moved past.
			if (history.calls.get(call.id) === null) return commit(tracker, new Map(), budget)
			// Attribution before outcome, for every mutation the walk reaches. A call
			// the transcript never answered — the unknown-outcome result the kernel's
			// own repair writes for one included — is precisely the call whose effect
			// on the file nobody knows: the process may have died with the write half
			// made. And a refusal is a tool's own report about this path, a drift
			// refusal above all, which read the disk and found the body this ledger
			// holds is not the body there. Carrying a claim through either would have
			// the first resumed request tell the model a file holds a body the
			// transcript itself says nobody can vouch for, so each withdraws the path
			// it names — and only that path. A mutation attributable to no path at all
			// is still the one thing that stops the pass, because then there is no
			// path to withdraw.
			const key = mutatedKey(history, call, attributions)
			if (key === undefined) return commit(tracker, new Map(), budget)
			const claim: Claim = answered
				? mutate(history, call, name, key, claims.get(key), budget)
				: { kind: 'seen' }
			claims.set(key, claim)
			withBody.delete(key)
			if (claim.kind === 'content') withBody.add(key)
			// Oldest body first, matching what the projection keeps. An evicted
			// path is one this pass stops vouching for: it was mutated here, and
			// what it holds is past what the pass can carry, so it reaches the
			// ledger as the nothing every unrebuilt path reaches it as.
			if (withBody.size > MAX_WITNESSED_PATHS) {
				const oldest = withBody.values().next().value as string
				withBody.delete(oldest)
				// Setting an existing key leaves it where it is, so the order the
				// ledger is written in stays the order the calls arrived in.
				claims.set(oldest, { kind: 'seen' })
			}
		}
	}

	return commit(tracker, claims, budget)
}

/** Apply a walk's surviving claims to the ledger, in the order they were made. */
function commit(
	tracker: FileReadTracker,
	claims: ReadonlyMap<string, Claim>,
	budget: ReplayBudget,
): LedgerReplayReport {
	let pathsWitnessed = 0
	let pathsSeen = 0
	for (const [key, claim] of claims) {
		if (claim.kind === 'seen') {
			// Nothing. Not even membership: `hasRead` is the read-before-overwrite
			// refusal, and granting it without a fingerprint would let a full
			// overwrite of this path through with no body to compare — over a file
			// that may have moved while the session was closed. The claim was
			// carried through the walk so that no edit stacked onto a body
			// something unseen had replaced; having done that, it is dropped.
			pathsSeen++
			continue
		}
		for (const step of claim.steps) {
			if (step.kind === 'write') {
				tracker.recordRead(key, step.body, step.callId)
			} else if (tracker.recordEdit) {
				tracker.recordEdit(key, step.content, step.callId)
			} else {
				// The same fallback the `edit` tool takes against a tracker without
				// the method: the observation advances and no chain is built.
				tracker.recordRead(key, step.content)
			}
		}
		pathsWitnessed++
	}
	return { pathsWitnessed, pathsSeen, unitsReplayed: MAX_REPLAYED_UNITS - budget.remaining }
}

/** Fold one successful mutation into the path's claim. */
function mutate(
	history: VisibleHistory,
	call: ToolCall,
	name: 'write' | 'edit',
	key: string,
	claim: Claim | undefined,
	budget: ReplayBudget,
): Claim {
	if (name === 'write') {
		const written = visibleWrite(history, call.id)
		// A write nothing may quote back is still a write that HAPPENED, and the
		// path it happened to is known: arguments past the evidence bound, a call
		// the stream truncated, a path longer than an entry goes out with, a key
		// the call and the ledger disagree about. Each of those withdraws the
		// body and keeps the walk going — what was on this path is now unknown,
		// which is a statement about one path rather than a reason to stop. A
		// call a hook SKIPPED lands here too, from the other direction: that one
		// never ran, so the file holds whatever it held before and this pass
		// cannot say what that was either.
		if (!written || written.key !== key) return { kind: 'seen' }
		if (!spend(budget, written.body.length)) return { kind: 'seen' }
		// A full body replaces everything under it, chain included.
		return {
			kind: 'content',
			body: written.body,
			steps: [{ kind: 'write', body: written.body, callId: call.id }],
		}
	}
	// An edit onto a body this pass is not holding cannot be replayed onto
	// anything, and one onto a chain already at its bound stops being followed.
	if (!claim || claim.kind !== 'content') return { kind: 'seen' }
	if (claim.steps.length > MAX_EDIT_CALLS) return { kind: 'seen' }
	const hop = visibleEdit(history, call.id)
	if (!hop || hop.key !== key) return { kind: 'seen' }
	const replayed = replayHop(claim.body, hop.input, budget)
	if (replayed === undefined) return { kind: 'seen' }
	claim.body = replayed
	claim.steps.push({ kind: 'edit', content: replayed, callId: call.id })
	return claim
}

/**
 * Confirm or withdraw a body this pass holds, from a `read` that observed it.
 *
 * A read changes no file, so on its own it establishes nothing: a partial read
 * shows a window, and a body cannot be recovered from the rendering without
 * stripping the line numbers back off — which would be inventing a file from
 * text that was formatted for a reader, and is exactly what the ledger's
 * contract forbids. What a read CAN do is settle whether a body already
 * reconstructed here is the one the read saw. The rendering is produced
 * forwards, from the body in hand through the read tool's own renderer, and
 * compared whole.
 *
 * Equality is conclusive because of the numbering. Every line of a rendering
 * goes out behind its own `${n}\t`, so one rendering belongs to exactly one
 * body and window; and the partial-view notice carries no such prefix on its
 * lines, so a rendering that covers a whole file cannot be equal to one that
 * was cut short. A read this cannot match leaves the path known and its body
 * withdrawn — the honest answer, and the one the drift check then re-derives
 * from disk.
 */
function observeRead(
	history: VisibleHistory,
	call: ToolCall,
	claims: Map<string, Claim>,
	withBody: Set<string>,
	budget: ReplayBudget,
): void {
	const read = readWindow(history, call)
	if (!read) return
	const claim = claims.get(read.key)
	if (!claim || claim.kind !== 'content') return
	const shown = history.results.get(call.id)?.content
	if (visibleCall(history, call.id, 'read') && typeof shown === 'string') {
		// A whole-file rendering is the body plus a number on every line, so one
		// shorter than the body it would render cannot be equal to it. The cheap
		// half of the comparison, taken before anything is measured.
		const units =
			shown.length < claim.body.length ? undefined : wholeFileRenderUnits(claim.body, read.window)
		// The rendering is content this pass materialises, so it is charged like
		// every other body — and charged for what it will actually come to,
		// worked out from the body and the window while the string does not exist
		// yet. Charging the RECEIPT's length was charging one number and building
		// another: a receipt that had been rewritten short could have the pass
		// build a rendering the ceiling had never been asked about.
		if (units !== undefined && spend(budget, units)) {
			const rendered = renderNumberedRead(claim.body, read.window)
			if (!rendered.partial && rendered.output === shown) return
		}
	}
	claims.set(read.key, { kind: 'seen' })
	// Off the held list as well as out of the claim. A withdrawn path is one
	// this pass is no longer carrying a body for, so counting it against the
	// eviction bound would have a later mutation evict a path that IS still
	// holding one — the pass would then write fewer witnesses than the
	// projection can emit, and the one it dropped was admissible.
	withBody.delete(read.key)
}

/**
 * What `read` would return for this whole body, in UTF-16 units, without
 * building it — and `undefined` for a window that would leave a line out.
 *
 * The rendering puts `${n}\t` in front of every line and joins them back with
 * the newlines the body already carries, so its length is the body's, plus one
 * tab per line, plus the digits of the numbers `1..lines`. A windowed read
 * renumbers from its offset and carries the PARTIAL notice, and can never equal
 * a whole body's rendering — so it is refused here rather than built and
 * compared, which is also what makes the figure above exact.
 */
function wholeFileRenderUnits(body: string, window: ReadWindowRequest): number | undefined {
	const lines = countLines(body)
	const { start, end } = resolveReadWindow(window, lines)
	if (start !== 0 || end < lines) return undefined
	return body.length + lines + lineNumberUnits(lines)
}

/** Lines the way `String.split('\n')` counts them, without building the array. */
function countLines(body: string): number {
	let lines = 1
	for (let at = body.indexOf('\n'); at !== -1; at = body.indexOf('\n', at + 1)) lines++
	return lines
}

/** Units the line numbers `1..lines` occupy, counted by decade rather than one by one. */
function lineNumberUnits(lines: number): number {
	let units = 0
	for (let width = 1, first = 1; first <= lines; width++, first *= 10)
		units += (Math.min(lines, first * 10 - 1) - first + 1) * width
	return units
}

/**
 * The ledger key a mutation belongs to, whatever the transcript says came back
 * — or `undefined` for one this pass cannot attribute to any file at all.
 *
 * Deliberately the declared path rather than the tool's own schema, and asked
 * before the outcome is. A call that fails validation in some OTHER field, that
 * is too long to read as evidence, that was never answered or that was refused
 * still says which file it was aimed at, and a mutation that can be attributed
 * can be honoured — as a content-changing observation nothing here can replay,
 * which costs the path it names and no other. A key is exactly what withdrawing
 * one path rather than the whole pass requires. `undefined` is kept for the two
 * things that really are unattributable: a call naming no path, and a path this
 * run may not reach, whose key the resolver therefore withheld. Those, and only
 * those, stop the pass — a refused call included, because a refusal this pass
 * cannot place is a refusal it cannot act on either.
 */
function mutatedKey(
	history: VisibleHistory,
	call: ToolCall,
	attributions: PathAttributions,
): string | undefined {
	const path = declaredPath(call, attributions)
	return path === undefined ? undefined : history.keyOf(path)
}

/** The path and window one `read` call asked for. */
function readWindow(
	history: VisibleHistory,
	call: ToolCall,
): { readonly key: string; readonly window: ReadWindowRequest } | undefined {
	const input = ReadFileTool.inputSchema.safeParse(parseArguments(call))
	if (!input.success) return undefined
	const key = history.keyOf(input.data.path)
	// A read this pass cannot key cannot contradict a claim either: the only
	// claims it holds came from mutations, and a mutation whose path would
	// not resolve stopped the pass before it made one.
	return key === undefined ? undefined : { key, window: input.data }
}
