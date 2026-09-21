import { describe, expect, it } from 'vitest'

import { ScanSessionIndex } from '../../store/session-index/scan.js'
import { generateSessionId } from '../../utils/id.js'
import { startIndexedSession } from '../__fixtures__/indexed-session.js'
import { resolveExternalSession } from '../external-session.js'

/**
 * The shared resolution every protocol adapter uses for "the caller's name
 * for a session": an existing session id, then a ref the index derived from
 * a session's own records, then a new session that claims the name.
 */

describe('resolving a protocol id to a session', () => {
	it('uses an id that is an existing namzu session as that session', async () => {
		const index = new ScanSessionIndex()
		const sessionId = generateSessionId()
		await startIndexedSession(index, sessionId, { protocol: 'sdk' })

		await expect(
			resolveExternalSession({ index, protocol: 'ag-ui', externalId: sessionId }),
		).resolves.toEqual({ kind: 'existing', sessionId, via: 'session-id' })
	})

	it('creates a session for an unknown id, and the next call finds it through the ref', async () => {
		const index = new ScanSessionIndex()
		const first = await resolveExternalSession({ index, protocol: 'ag-ui', externalId: 'thread-9' })
		expect(first.kind).toBe('new')
		if (first.kind !== 'new') return
		expect(first.origin).toEqual({ protocol: 'ag-ui', externalSessionId: 'thread-9' })

		await startIndexedSession(index, first.sessionId, first.origin)

		await expect(
			resolveExternalSession({ index, protocol: 'ag-ui', externalId: 'thread-9' }),
		).resolves.toEqual({ kind: 'existing', sessionId: first.sessionId, via: 'external-ref' })
		// A name is scoped to its protocol: the same string from another
		// protocol is somebody else's.
		const other = await resolveExternalSession({ index, protocol: 'a2a', externalId: 'thread-9' })
		expect(other.kind).toBe('new')
	})

	it('treats a UUID that names no session as opaque, not as a session id', async () => {
		const index = new ScanSessionIndex()
		const stranger = generateSessionId()
		const resolved = await resolveExternalSession({ index, protocol: 'acp', externalId: stranger })
		expect(resolved.kind).toBe('new')
		expect(resolved.sessionId).not.toBe(stranger)
	})

	it('creates a session with no external name when the caller sent none', async () => {
		const index = new ScanSessionIndex()
		const minted = generateSessionId()
		await expect(
			resolveExternalSession({
				index,
				protocol: 'a2a',
				externalId: '',
				newSessionId: () => minted,
			}),
		).resolves.toEqual({ kind: 'new', sessionId: minted, origin: { protocol: 'a2a' } })
	})
})
