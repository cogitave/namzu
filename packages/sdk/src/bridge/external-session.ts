import type { SessionIndex } from '../store/session-index/index.js'
import { sessionRefKind } from '../store/session-index/refs.js'
import type { SessionId } from '../types/ids/index.js'
import type { Origin, OriginProtocol } from '../types/session/turn.js'
import { generateSessionId, isEntityId } from '../utils/id.js'

/**
 * Resolving a protocol's own name for a session (an AG-UI thread, an A2A
 * context, an ACP session id) to a namzu session.
 *
 * The protocol's id is any string. It is never parsed as anything but a
 * possible namzu session id, and never read as a project. The order is:
 *
 *  1. an id that is an existing namzu session: that session;
 *  2. an id the index has seen claimed by a session (`external_refs`): that
 *     session;
 *  3. anything else: a new session, whose `origin` claims the id.
 *
 * Nothing writes the mapping directly. The new session's first turn records
 * `origin`, the index derives the ref from that record, and so a second call
 * with the same id finds the same session even after the index is rebuilt.
 */

/** The two index reads resolution needs. `SessionIndex` has both. */
export type ExternalSessionLookup = Pick<SessionIndex, 'getSession' | 'resolveExternal'>

export type ExternalSessionResolution =
	| {
			readonly kind: 'existing'
			readonly sessionId: SessionId
			/** How the id was matched: it was the session id, or a ref the session claimed. */
			readonly via: 'session-id' | 'external-ref'
	  }
	| {
			readonly kind: 'new'
			/** The id to create the session under. */
			readonly sessionId: SessionId
			/** Record this on the session's first turn; it carries the protocol's id. */
			readonly origin: Origin
	  }

export interface ResolveExternalSessionOptions {
	readonly index: ExternalSessionLookup
	readonly protocol: OriginProtocol
	/** The protocol's own id. Absent or empty: a new session with no external name. */
	readonly externalId?: string
	/** Injectable for tests. Defaults to `generateSessionId` (UUIDv7). */
	readonly newSessionId?: () => SessionId
}

export async function resolveExternalSession(
	options: ResolveExternalSessionOptions,
): Promise<ExternalSessionResolution> {
	const { index, protocol } = options
	const mint = options.newSessionId ?? generateSessionId
	const externalId =
		options.externalId !== undefined && options.externalId.length > 0
			? options.externalId
			: undefined

	if (externalId === undefined) {
		return { kind: 'new', sessionId: mint(), origin: { protocol } }
	}

	if (isEntityId(externalId, 'session')) {
		const session = await index.getSession(externalId)
		if (session !== undefined) {
			return { kind: 'existing', sessionId: session.id, via: 'session-id' }
		}
	}

	const ref = await index.resolveExternal(protocol, sessionRefKind(protocol), externalId)
	if (ref !== undefined) {
		return { kind: 'existing', sessionId: ref.sessionId, via: 'external-ref' }
	}

	return {
		kind: 'new',
		sessionId: mint(),
		origin: { protocol, externalSessionId: externalId },
	}
}
