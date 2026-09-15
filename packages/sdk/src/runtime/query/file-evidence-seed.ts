import { resolveWithinAnyReal, toolRoots } from '../../tools/paths.js'
import type { Message } from '../../types/message/index.js'
import type { FileReadTracker } from '../../types/tool/index.js'
import {
	type FileKeyResolver,
	type LedgerReplayReport,
	type PathAttributions,
	collectObservedPaths,
	createPathAttributions,
	replayObservationLedger,
} from './file-evidence-replay.js'

/**
 * Seeding an observation ledger from history, in the key space the tools use.
 *
 * The replay itself is pure and stays that way. What lives here is the one
 * thing it cannot do for itself: work out which ledger key each path in the
 * history belongs to. On a host that is not `resolve(cwd, path)` — `write`,
 * `edit` and `read` all key on `resolveWithinAnyReal`, which canonicalizes
 * every symlink on the way, because a ledger entry has to identify a FILE and
 * two spellings of one file must not become two entries.
 *
 * Seeding lexically instead is worse than useless. The projection looks up
 * lexically too, so it would match a fingerprint the seed had just written into
 * a key space nothing else touches — while every drift refusal, made by a tool,
 * lands on the canonical key and never withdraws it. The runtime would go on
 * telling the model a body it can no longer vouch for, with no mechanism left
 * to take it back. So the resolution happens here, with the tools' own
 * function, and a path that will not resolve gets no key at all.
 */
const NOTHING: LedgerReplayReport = { pathsWitnessed: 0, pathsSeen: 0, unitsReplayed: 0 }

/**
 * Distinct paths one seeding will canonicalize before it replays anything.
 *
 * A ceiling rather than a budget because the work is uniform: each path is a
 * handful of `realpath` calls, once per conversation. Counted on distinct
 * SPELLINGS, the ones only `read` names included — a read has to be keyed too
 * or it cannot contradict a claim — so two spellings of one file count twice.
 * A history naming more paths than this is not a conversation whose ledger is
 * worth guessing at, and it seeds nothing rather than resolving a prefix and
 * abandoning the rest — a partially keyed walk is a walk that cannot say what
 * a mutation replaced. That is a total loss for the conversation, not a partial
 * one: it starts from the empty ledger a resume has always started from, and
 * its first mutation of each path re-establishes it.
 */
export const MAX_RESOLVED_PATHS = 1024

/** What a caller needs to key a path the way its tools will. */
export interface ObservationSeedContext {
	readonly workingDirectory: string
	/** See `ToolContext.additionalDirectories`; part of the tools' resolution. */
	readonly additionalDirectories?: readonly string[]
	/** True when this run's tools address a sandbox, whose keys are paths as written. */
	readonly sandboxed?: boolean
}

/**
 * Rebuild `tracker` from a conversation's own `messages`.
 *
 * For a host that keeps one tracker per conversation and has just restored one:
 * the ledger is process memory, so a resumed conversation starts with nothing
 * in it and re-reads files whose whole body is already in the transcript. Call
 * it once, before the conversation's first request. Reading files is confined
 * to canonicalizing the paths in the history; no file's CONTENT is read, and
 * every body restored is one the visible calls reconstruct exactly.
 *
 * Content-backed observations, and only those. A path the walk cannot rebuild
 * is left out of the ledger rather than entered without a fingerprint, so
 * `write`'s read-before-overwrite refusal stands over it exactly as it does
 * against the empty ledger a resume gets today. Three things seed nothing at
 * all, and the report says so: a history naming more than
 * {@link MAX_RESOLVED_PATHS} distinct path spellings, one whose ids are
 * ambiguous, and one holding a mutation no path can be recovered from —
 * whatever the transcript says came back to that mutation, since a key is what
 * withdrawing one path rather than the whole pass takes. A call whose arguments
 * are too long to read as JSON at all is one of that last kind; the replay
 * states the ceiling.
 */
export async function seedObservationLedger(
	messages: readonly Message[],
	tracker: FileReadTracker,
	context: ObservationSeedContext,
): Promise<LedgerReplayReport> {
	// One attribution cache across both halves. The path collection and the
	// walk ask the same question of the same calls — which file did this touch
	// — and answering it means reading a string that, for a `write`, is a whole
	// file body. Asking once per seeding rather than once per half is why the
	// replay's own ceiling on that read can be as generous as it is.
	const attributions = createPathAttributions()
	const keyOf = await resolveObservedFileKeys(messages, context, attributions)
	return keyOf ? replayObservationLedger(messages, tracker, keyOf, attributions) : NOTHING
}

/**
 * The tools' key for every path this history names, or `undefined` when the
 * pass should not run at all.
 *
 * `undefined` for a history with nothing to reconstruct and for one past the
 * ceiling. A path the resolver refuses — it escapes the roots this run may
 * reach, or the working directory itself is gone — is simply left unkeyed;
 * the replay then treats the mutation that named it as unattributable, which
 * is the fail-closed answer and the same one it gives a call it cannot parse.
 */
async function resolveObservedFileKeys(
	messages: readonly Message[],
	context: ObservationSeedContext,
	attributions: PathAttributions,
): Promise<FileKeyResolver | undefined> {
	const paths = collectObservedPaths(messages, attributions)
	if (paths.length === 0 || paths.length > MAX_RESOLVED_PATHS) return undefined
	// A sandbox has its own root and its own resolver, and the tools key on the
	// path as written there. Canonicalizing it against the host filesystem would
	// ask about the wrong machine.
	if (context.sandboxed) return (path: string) => path
	const roots = toolRoots(context)
	const keys = new Map<string, string>()
	for (const path of paths) {
		try {
			keys.set(path, await resolveWithinAnyReal(roots, path))
		} catch {
			// Left unkeyed on purpose; see above.
		}
	}
	return (path: string) => keys.get(path)
}
