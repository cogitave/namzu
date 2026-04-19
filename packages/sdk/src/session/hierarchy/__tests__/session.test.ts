import { describe, expect, it } from 'vitest'
import type { RunStatus } from '../../../types/run/status.js'
import type {
	ProjectId,
	SessionId,
	TenantId,
	ThreadId,
	UserId,
} from '../../../types/session/ids.js'
import type { ActorRef } from '../actor.js'
import { type Session, type SessionStatus, deriveStatus } from '../session.js'

const tenant = 'tnt_a' as TenantId
const project = 'prj_a' as ProjectId
const thread = 'thd_a' as ThreadId

function user(): ActorRef {
	return { kind: 'user', userId: 'usr_a' as UserId, tenantId: tenant }
}

function makeSession(status: SessionStatus): Session {
	return {
		id: 'ses_a' as SessionId,
		threadId: thread,
		projectId: project,
		tenantId: tenant,
		status,
		currentActor: user(),
		previousActors: [],
		workspaceId: null,
		ownerVersion: 0,
		createdAt: new Date('2026-01-01'),
		updatedAt: new Date('2026-01-01'),
	}
}

function runs(...statuses: RunStatus[]): readonly { status: RunStatus }[] {
	return statuses.map((status) => ({ status }))
}

describe('deriveStatus', () => {
	it('empty run set → idle', () => {
		expect(deriveStatus(makeSession('idle'), [])).toBe('idle')
	})

	it('all succeeded → idle', () => {
		expect(deriveStatus(makeSession('idle'), runs('succeeded', 'succeeded'))).toBe('idle')
	})

	it('any running → active (overrides idle session status)', () => {
		expect(deriveStatus(makeSession('idle'), runs('succeeded', 'running'))).toBe('active')
	})

	it('any awaiting_subsession → active (delegation-in-flight parent is active)', () => {
		expect(deriveStatus(makeSession('idle'), runs('succeeded', 'awaiting_subsession'))).toBe(
			'active',
		)
	})

	it('awaiting_subsession alone → active', () => {
		expect(deriveStatus(makeSession('idle'), runs('awaiting_subsession'))).toBe('active')
	})

	it('any awaiting_hitl → awaiting_hitl', () => {
		expect(deriveStatus(makeSession('idle'), runs('succeeded', 'awaiting_hitl'))).toBe(
			'awaiting_hitl',
		)
	})

	it('any awaiting_hitl_resolution → awaiting_hitl (persisted HITL wait)', () => {
		expect(deriveStatus(makeSession('idle'), runs('awaiting_hitl_resolution'))).toBe(
			'awaiting_hitl',
		)
	})

	it('all failed → failed', () => {
		expect(deriveStatus(makeSession('idle'), runs('failed', 'failed'))).toBe('failed')
	})

	it('cancelled + failed + succeeded mix → idle (cancellation is not terminal Session state)', () => {
		expect(deriveStatus(makeSession('idle'), runs('succeeded', 'cancelled', 'failed'))).toBe('idle')
	})

	it('locked session-level state wins over derived (even with succeeded runs)', () => {
		expect(deriveStatus(makeSession('locked'), runs('succeeded'))).toBe('locked')
	})

	it('awaiting_merge session-level state wins over derived', () => {
		expect(deriveStatus(makeSession('awaiting_merge'), runs('succeeded'))).toBe('awaiting_merge')
	})

	it('archived session-level state wins over derived (retention tombstone)', () => {
		expect(deriveStatus(makeSession('archived'), runs('succeeded'))).toBe('archived')
	})

	it('running takes precedence over HITL', () => {
		// Two runs — one running, one HITL. Active is higher priority (§5.1).
		expect(deriveStatus(makeSession('idle'), runs('running', 'awaiting_hitl'))).toBe('active')
	})
})
