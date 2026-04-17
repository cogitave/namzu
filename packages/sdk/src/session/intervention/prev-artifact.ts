/**
 * prevArtifactRef DAG primitives — acyclic walker, cycle detection, depth
 * enforcement. See session-hierarchy.md §4.5.
 *
 * Intervention chains link successive follow-up sub-sessions via
 * `SubSession.prevArtifactRef`, forming a strict acyclic DAG over prior
 * completed sessions. This module supplies the pre-commit validator that
 * rejects any insertion that would close a cycle or overflow
 * {@link Project.config.maxInterventionDepth} (default 10).
 *
 * Convention #5: deny-by-default. Cycle or depth violation rejects with a
 * typed error; callers never get a silently-truncated chain.
 *
 * Convention #0: no silent fallbacks. The walker surfaces corruption as
 * `ArtifactRefCycleError` rather than infinite-looping.
 */

import type { SessionId } from '../../types/ids/index.js'
import type { SubSessionId } from '../../types/session/ids.js'
import type { DeliverableRef } from '../summary/deliverable.js'

/**
 * Minimal record the validator needs to step ancestrally from one
 * sub-session to its predecessor. Concrete stores provide this projection.
 *
 * `sessionId` is the completed session this node represents (the one the
 * incoming {@link DeliverableRef} pointed at). `subSessionId` is its own
 * sub-session edge id — used for the visited-set so intervention chains form
 * an acyclic DAG over sub-session identities.
 */
export interface PrevArtifactNode {
	readonly subSessionId: SubSessionId
	readonly sessionId: SessionId
	readonly prevArtifactRef?: DeliverableRef
}

/**
 * Raised when {@link validatePrevArtifactChain} detects a cycle — revisiting
 * a sub-session id already in the ancestry set. Indicates a bug in the caller
 * (or pre-existing store corruption); the write must be rejected.
 */
export class ArtifactRefCycleError extends Error {
	readonly details: {
		readonly startSubSessionId: SubSessionId
		readonly cyclePath: readonly SubSessionId[]
	}

	constructor(details: {
		startSubSessionId: SubSessionId
		cyclePath: readonly SubSessionId[]
	}) {
		super(
			`prevArtifactRef cycle starting at ${details.startSubSessionId}: ${details.cyclePath.join(' -> ')}`,
		)
		this.name = 'ArtifactRefCycleError'
		this.details = details
	}
}

/**
 * Raised when the resolved chain length exceeds the configured intervention
 * depth limit (`Project.config.maxInterventionDepth`). Convention #5
 * deny-by-default — the kernel does not auto-truncate.
 */
export class InterventionDepthExceeded extends Error {
	readonly details: {
		readonly subSessionId: SubSessionId
		readonly depth: number
		readonly limit: number
	}

	constructor(details: { subSessionId: SubSessionId; depth: number; limit: number }) {
		super(
			`Intervention chain depth ${details.depth} exceeds limit ${details.limit} at ${details.subSessionId}`,
		)
		this.name = 'InterventionDepthExceeded'
		this.details = details
	}
}

/**
 * Loader surface the validator queries to walk ancestry. Returning `null`
 * means "no further ancestor" — the chain terminates cleanly. The loader is
 * injected so tests can fake a chain without standing up a full
 * {@link SessionStore}.
 */
export interface InterventionChainLoader {
	/**
	 * Resolves the ancestor node for the supplied {@link SessionId} — the
	 * session that the last step's `SessionSummaryDeliverable.sessionId` named.
	 * Returns `null` when no sub-session edge exists for that session (root
	 * session, or an archived/tombstoned ancestor — see §12.3).
	 */
	loadAncestor(sessionId: SessionId): Promise<PrevArtifactNode | null>
}

/**
 * Pre-commit validator for adding a `prevArtifactRef` on a proposed child
 * sub-session. Walks from `candidateAncestor` backwards through
 * `loader.loadAncestor`, seeding the visited-set with `proposedChild` so a
 * cycle (the candidate chain loops back to the child) is rejected
 * immediately.
 *
 * Returns the resolved ancestry chain (oldest last, length ≤ `maxDepth`),
 * excluding `proposedChild` itself. The chain is ordered from
 * immediate-ancestor to furthest-ancestor (reverse-chronological per §4.5).
 *
 * Throws:
 * - {@link ArtifactRefCycleError} if the walk revisits `proposedChild` or
 *   any already-visited ancestor.
 * - {@link InterventionDepthExceeded} if the chain would exceed `maxDepth`.
 *
 * Non-session_summary deliverables (file / message / artifact_blob) do not
 * form chain links — the walker terminates cleanly when it encounters one,
 * since only `kind: 'session_summary'` references another sub-session's
 * ancestry.
 */
export async function validatePrevArtifactChain(
	loader: InterventionChainLoader,
	proposedChild: SubSessionId,
	candidateAncestor: DeliverableRef,
	maxDepth: number,
): Promise<readonly SubSessionId[]> {
	if (maxDepth <= 0) {
		throw new InterventionDepthExceeded({
			subSessionId: proposedChild,
			depth: 1,
			limit: maxDepth,
		})
	}

	// Non-session_summary refs are leaves — no chain links.
	if (candidateAncestor.kind !== 'session_summary') {
		return []
	}

	const visited = new Set<SubSessionId>([proposedChild])
	const chain: SubSessionId[] = []

	let currentRef: DeliverableRef | undefined = candidateAncestor

	while (currentRef !== undefined) {
		if (currentRef.kind !== 'session_summary') {
			// Chain terminates on non-session deliverable.
			return chain
		}

		// `SessionSummaryDeliverable.sessionId` names the completed session the
		// ref points at. The loader resolves that to the sub-session edge
		// carrying its own `prevArtifactRef` (if any), giving us the next step.
		const ancestorNode = await loader.loadAncestor(currentRef.sessionId)
		if (!ancestorNode) {
			// Unknown ancestor (root session, or archived / tombstoned). Chain
			// ends cleanly — absence is not a cycle.
			return chain
		}

		if (visited.has(ancestorNode.subSessionId)) {
			throw new ArtifactRefCycleError({
				startSubSessionId: proposedChild,
				cyclePath: [...chain, ancestorNode.subSessionId],
			})
		}

		visited.add(ancestorNode.subSessionId)
		chain.push(ancestorNode.subSessionId)

		if (chain.length > maxDepth) {
			throw new InterventionDepthExceeded({
				subSessionId: proposedChild,
				depth: chain.length,
				limit: maxDepth,
			})
		}

		currentRef = ancestorNode.prevArtifactRef
	}

	return chain
}
