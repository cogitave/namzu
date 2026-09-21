import type { SessionId } from '../../types/ids/index.js'
import type { Origin } from '../../types/session/turn.js'
import { type ExternalSessionLookup, resolveExternalSession } from '../external-session.js'

/**
 * An A2A `contextId`, resolved to the namzu session it names.
 *
 * A context is a session. An incoming id that is an existing session, or that
 * a session already claimed, reaches that session; any other id creates one.
 * The id is opaque: a legacy client that still sends its project UUID gets one
 * session for that id, and the id is never read as a project. With no
 * `contextId`, a new session is created and its id is the context id the host
 * returns.
 */
export interface A2AContextResolution {
	readonly sessionId: SessionId
	/** The context id to put on every task and event: the peer's own, or the new session's id. */
	readonly contextId: string
	/** True when the host must create the session (its first turn records `origin`). */
	readonly created: boolean
	/** Present when `created`: record it on the new session's first turn. */
	readonly origin?: Origin
}

export async function resolveA2AContext(
	contextId: string | undefined,
	index: ExternalSessionLookup,
	options: { readonly newSessionId?: () => SessionId } = {},
): Promise<A2AContextResolution> {
	const resolution = await resolveExternalSession({
		index,
		protocol: 'a2a',
		...(contextId !== undefined && { externalId: contextId }),
		...(options.newSessionId !== undefined && { newSessionId: options.newSessionId }),
	})
	const echoed = contextId !== undefined && contextId.length > 0 ? contextId : resolution.sessionId
	if (resolution.kind === 'existing') {
		return { sessionId: resolution.sessionId, contextId: echoed, created: false }
	}
	return {
		sessionId: resolution.sessionId,
		contextId: echoed,
		created: true,
		origin: { ...resolution.origin, kind: 'prompt' },
	}
}
