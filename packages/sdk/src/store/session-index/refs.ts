import type { SessionId, TurnId } from '../../types/ids/index.js'
import type { SessionRecord } from '../../types/session/records.js'
import type { ExternalRef, Origin } from '../../types/session/turn.js'

/**
 * How the index derives `external_refs`: only from `session_started.origin`,
 * `turn_started.origin` and `session_updated.externalRefs` (spec D9). Nothing
 * writes a ref directly, so a rebuild from the logs reproduces every one.
 *
 * An external id is any string. It is never parsed, never required to be a
 * UUID, and never read as a namzu id.
 */

/**
 * The kinds of caller-side name the index resolves. The three session kinds
 * are {@link ExternalRef}'s; `turn` names one turn by the caller's own id for
 * it (`origin.externalTurnId`, such as the run id an AG-UI client sent).
 */
export type ExternalRefKind = ExternalRef['kind'] | 'turn'

/** One claim a session log makes on a caller-side name. */
export interface ExternalRefClaim {
	readonly protocol: string
	readonly kind: ExternalRefKind
	readonly externalId: string
	readonly sessionId: SessionId
	/** The turn a `turn` ref names; absent on the session kinds. */
	readonly turnId?: TurnId
	/** The claiming record's `ts`: the earliest claim on a name wins. */
	readonly claimedAt: string
	/** The claiming record's `seq`, the tie-break within one timestamp. */
	readonly claimedSeq: number
}

/** What a caller-side name resolves to. */
export interface ExternalRefTarget {
	readonly protocol: string
	readonly kind: ExternalRefKind
	readonly externalId: string
	readonly sessionId: SessionId
	readonly turnId?: TurnId
}

/**
 * The session kind an origin's `externalSessionId` is filed under: an AG-UI
 * thread, an A2A context, and a session for every other protocol (ACP, the
 * desktop map, HTTP hosts).
 */
export function sessionRefKind(protocol: Origin['protocol'] | string): ExternalRef['kind'] {
	if (protocol === 'ag-ui') return 'thread'
	if (protocol === 'a2a') return 'context'
	return 'session'
}

/** A change to the refs one record makes. */
export type ExternalRefChange =
	| { readonly op: 'claim'; readonly claim: ExternalRefClaim }
	| {
			readonly op: 'release'
			readonly protocol: string
			readonly kind: ExternalRefKind
			readonly externalId: string
			readonly sessionId: SessionId
	  }

function originClaims(
	origin: Origin | undefined,
	record: SessionRecord,
	turnId: TurnId | undefined,
): ExternalRefChange[] {
	if (origin === undefined) return []
	const changes: ExternalRefChange[] = []
	const base = { sessionId: record.sessionId, claimedAt: record.ts, claimedSeq: record.seq }
	if (origin.externalSessionId !== undefined && origin.externalSessionId.length > 0) {
		changes.push({
			op: 'claim',
			claim: {
				...base,
				protocol: origin.protocol,
				kind: sessionRefKind(origin.protocol),
				externalId: origin.externalSessionId,
			},
		})
	}
	if (
		turnId !== undefined &&
		origin.externalTurnId !== undefined &&
		origin.externalTurnId.length > 0
	) {
		changes.push({
			op: 'claim',
			claim: {
				...base,
				protocol: origin.protocol,
				kind: 'turn',
				externalId: origin.externalTurnId,
				turnId,
			},
		})
	}
	return changes
}

/** The ref changes one record makes, in the order they apply. */
export function externalRefChanges(record: SessionRecord): ExternalRefChange[] {
	switch (record.type) {
		case 'session_started':
			return originClaims(record.origin, record, undefined)
		case 'turn_started':
			return originClaims(record.origin, record, record.turnId)
		case 'session_updated': {
			const refs = record.externalRefs
			if (refs === undefined) return []
			const changes: ExternalRefChange[] = []
			for (const ref of refs.add ?? []) {
				changes.push({
					op: 'claim',
					claim: {
						protocol: ref.protocol,
						kind: ref.kind,
						externalId: ref.externalId,
						sessionId: record.sessionId,
						claimedAt: record.ts,
						claimedSeq: record.seq,
					},
				})
			}
			for (const ref of refs.remove ?? []) {
				changes.push({
					op: 'release',
					protocol: ref.protocol,
					kind: ref.kind,
					externalId: ref.externalId,
					sessionId: record.sessionId,
				})
			}
			return changes
		}
		default:
			return []
	}
}

/**
 * Orders competing claims on one name: earliest `claimedAt`, then the lower
 * session id, then the lower seq. The order depends only on the claims, never
 * on the order logs were indexed in, so a rebuild resolves a contested name
 * exactly as the incremental index did.
 */
export function compareClaims(a: ExternalRefClaim, b: ExternalRefClaim): number {
	if (a.claimedAt !== b.claimedAt) return a.claimedAt < b.claimedAt ? -1 : 1
	if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1
	return a.claimedSeq - b.claimedSeq
}

export function claimTarget(claim: ExternalRefClaim): ExternalRefTarget {
	return {
		protocol: claim.protocol,
		kind: claim.kind,
		externalId: claim.externalId,
		sessionId: claim.sessionId,
		...(claim.turnId === undefined ? {} : { turnId: claim.turnId }),
	}
}
