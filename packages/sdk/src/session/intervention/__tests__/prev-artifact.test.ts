import { describe, expect, it } from 'vitest'
import type { SessionId } from '../../../types/ids/index.js'
import type { DeliverableId, SubSessionId, SummaryId } from '../../../types/session/ids.js'
import type { DeliverableRef, SessionSummaryDeliverable } from '../../summary/deliverable.js'
import {
	ArtifactRefCycleError,
	type InterventionChainLoader,
	InterventionDepthExceeded,
	type PrevArtifactNode,
	validatePrevArtifactChain,
} from '../prev-artifact.js'

// Helpers -------------------------------------------------------------------

function sessionId(n: number): SessionId {
	return `ses_${n}` as SessionId
}

function subId(n: number): SubSessionId {
	return `sub_${n}` as SubSessionId
}

function summaryDeliverable(targetSession: SessionId): SessionSummaryDeliverable {
	return {
		id: 'del_test' as DeliverableId,
		kind: 'session_summary',
		sessionId: targetSession,
		summaryRef: 'sum_test' as SummaryId,
		at: new Date('2026-04-17T00:00:00Z'),
	}
}

/**
 * Build a loader that walks a pre-configured chain. `chain[i]` is the node
 * returned for the i'th step (keyed by the session id the previous step
 * targeted). `nodesBySession` keys the loader by `sessionId`.
 */
function buildLoader(
	nodes: Array<PrevArtifactNode & { bySession: SessionId }>,
): InterventionChainLoader {
	const map = new Map<SessionId, PrevArtifactNode>()
	for (const n of nodes) {
		map.set(n.bySession, {
			subSessionId: n.subSessionId,
			sessionId: n.sessionId,
			...(n.prevArtifactRef !== undefined && { prevArtifactRef: n.prevArtifactRef }),
		})
	}
	return {
		loadAncestor: async (sid) => map.get(sid) ?? null,
	}
}

describe('validatePrevArtifactChain', () => {
	it('accepts a depth-1 chain (direct parent only)', async () => {
		const loader = buildLoader([
			{
				bySession: sessionId(1),
				subSessionId: subId(1),
				sessionId: sessionId(1),
				// No prevArtifactRef — chain terminates here.
			},
		])
		const chain = await validatePrevArtifactChain(
			loader,
			subId(100),
			summaryDeliverable(sessionId(1)),
			10,
		)
		expect(chain).toEqual([subId(1)])
	})

	it('accepts a depth-2 chain', async () => {
		const loader = buildLoader([
			{
				bySession: sessionId(1),
				subSessionId: subId(1),
				sessionId: sessionId(1),
				prevArtifactRef: summaryDeliverable(sessionId(2)),
			},
			{
				bySession: sessionId(2),
				subSessionId: subId(2),
				sessionId: sessionId(2),
			},
		])
		const chain = await validatePrevArtifactChain(
			loader,
			subId(100),
			summaryDeliverable(sessionId(1)),
			10,
		)
		expect(chain).toEqual([subId(1), subId(2)])
	})

	it('accepts a chain exactly at the depth limit', async () => {
		// 10-deep chain with maxDepth = 10.
		const nodes: Array<PrevArtifactNode & { bySession: SessionId }> = []
		for (let i = 1; i <= 10; i++) {
			nodes.push({
				bySession: sessionId(i),
				subSessionId: subId(i),
				sessionId: sessionId(i),
				...(i < 10 && { prevArtifactRef: summaryDeliverable(sessionId(i + 1)) }),
			})
		}
		const loader = buildLoader(nodes)
		const chain = await validatePrevArtifactChain(
			loader,
			subId(100),
			summaryDeliverable(sessionId(1)),
			10,
		)
		expect(chain).toHaveLength(10)
	})

	it('rejects a chain that would exceed the depth limit', async () => {
		// 11-deep chain with maxDepth = 10.
		const nodes: Array<PrevArtifactNode & { bySession: SessionId }> = []
		for (let i = 1; i <= 11; i++) {
			nodes.push({
				bySession: sessionId(i),
				subSessionId: subId(i),
				sessionId: sessionId(i),
				...(i < 11 && { prevArtifactRef: summaryDeliverable(sessionId(i + 1)) }),
			})
		}
		const loader = buildLoader(nodes)
		await expect(
			validatePrevArtifactChain(loader, subId(100), summaryDeliverable(sessionId(1)), 10),
		).rejects.toBeInstanceOf(InterventionDepthExceeded)
	})

	it('rejects self-reference as a cycle', async () => {
		// proposedChild's prev points at a node whose subSessionId == proposedChild.
		const loader = buildLoader([
			{
				bySession: sessionId(1),
				subSessionId: subId(100), // SAME id as proposedChild
				sessionId: sessionId(1),
			},
		])
		await expect(
			validatePrevArtifactChain(loader, subId(100), summaryDeliverable(sessionId(1)), 10),
		).rejects.toBeInstanceOf(ArtifactRefCycleError)
	})

	it('rejects a 2-cycle (A -> B -> A)', async () => {
		const loader = buildLoader([
			{
				bySession: sessionId(1),
				subSessionId: subId(1),
				sessionId: sessionId(1),
				prevArtifactRef: summaryDeliverable(sessionId(2)),
			},
			{
				bySession: sessionId(2),
				subSessionId: subId(2),
				sessionId: sessionId(2),
				prevArtifactRef: summaryDeliverable(sessionId(1)),
			},
		])
		await expect(
			validatePrevArtifactChain(loader, subId(100), summaryDeliverable(sessionId(1)), 10),
		).rejects.toBeInstanceOf(ArtifactRefCycleError)
	})

	it('rejects a 3-cycle (A -> B -> C -> A)', async () => {
		const loader = buildLoader([
			{
				bySession: sessionId(1),
				subSessionId: subId(1),
				sessionId: sessionId(1),
				prevArtifactRef: summaryDeliverable(sessionId(2)),
			},
			{
				bySession: sessionId(2),
				subSessionId: subId(2),
				sessionId: sessionId(2),
				prevArtifactRef: summaryDeliverable(sessionId(3)),
			},
			{
				bySession: sessionId(3),
				subSessionId: subId(3),
				sessionId: sessionId(3),
				prevArtifactRef: summaryDeliverable(sessionId(1)),
			},
		])
		await expect(
			validatePrevArtifactChain(loader, subId(100), summaryDeliverable(sessionId(1)), 10),
		).rejects.toBeInstanceOf(ArtifactRefCycleError)
	})

	it('returns an empty chain for a non-session_summary deliverable', async () => {
		const fileRef: DeliverableRef = {
			id: 'del_file' as DeliverableId,
			kind: 'file',
			path: 'a.txt',
			contentHash: 'abc',
			sizeBytes: 0,
		}
		const loader: InterventionChainLoader = {
			loadAncestor: async () => null,
		}
		const chain = await validatePrevArtifactChain(loader, subId(100), fileRef, 10)
		expect(chain).toEqual([])
	})

	it('terminates cleanly on unknown ancestor (archived/tombstoned)', async () => {
		const loader = buildLoader([
			// no matching node — loadAncestor returns null for any id
		])
		const chain = await validatePrevArtifactChain(
			loader,
			subId(100),
			summaryDeliverable(sessionId(42)),
			10,
		)
		expect(chain).toEqual([])
	})

	it('rejects zero/negative maxDepth as depth-exceeded up front', async () => {
		const loader = buildLoader([
			{
				bySession: sessionId(1),
				subSessionId: subId(1),
				sessionId: sessionId(1),
			},
		])
		await expect(
			validatePrevArtifactChain(loader, subId(100), summaryDeliverable(sessionId(1)), 0),
		).rejects.toBeInstanceOf(InterventionDepthExceeded)
	})
})
