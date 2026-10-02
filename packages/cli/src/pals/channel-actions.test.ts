import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type PalChannelActionContext,
	generateCheckpointId,
	generateMessageId,
	generateSessionId,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeSessions, openSessions } from '../integrations/sessions/store.js'
import type { PalReviewAction } from './actions.js'
import { createCliPalChannelActions } from './channel-actions.js'
import { createPal } from './store.js'

// This tests the adapter's binding and payload boundary; the real journal gate has separate tests.
const gate = vi.hoisted(() => ({
	execute: vi.fn(async (action: PalReviewAction) => ({
		status: 'resolved' as const,
		operationId: action.operationId,
		decisionId: action.waiting.decisionId,
		requestRecord: action.waiting.requestRecord,
		resolutionRecord: { seq: 10, offset: 10, length: 10, sha256: 'f'.repeat(64) },
	})),
}))
vi.mock('./actions.js', () => ({ createCliPalReviewActions: () => gate }))
const temporary: string[] = []
afterEach(async () => {
	gate.execute.mockClear()
	vi.unstubAllEnvs()
	for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-channel-action-'))
	temporary.push(root)
	await mkdir(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
	const profile = createPal({ name: 'Action bridge' })
	const state = await openSessions(profile.workspace)
	const scope = {
		tenantId: state.tenantId,
		projectId: state.projectId,
		sessionId: generateSessionId(),
	}
	const paths = state.paths
	closeSessions(state)
	const turnId = generateTurnId()
	const ref = { namespace: 'namzu-pal-channel/1', id: 'a'.repeat(64), digest: 'b'.repeat(64) }
	const pointer = { seq: 1, offset: 0, length: 1, sha256: 'c'.repeat(64) }
	const identity = {
		provider: 'local-fixture',
		connectionId: 'connection',
		externalTenantId: 'external-tenant',
		nativeConversationId: 'conversation',
		nativeChannelId: null,
		nativeThreadId: 'thread',
	}
	const payload = JSON.stringify({
		waiting: {
			sessionId: scope.sessionId,
			turnId,
			checkpointId: generateCheckpointId(),
			decisionId: 'native-decision',
			requestKind: 'tool_review',
			requestRecord: pointer,
			checkpointDocSha256: 'd'.repeat(64),
		},
		answer: { action: 'approve_once' },
	})
	const context: PalChannelActionContext = {
		route: {
			connection: {
				tenantId: scope.tenantId,
				provider: identity.provider,
				connectionId: identity.connectionId,
				externalTenantId: identity.externalTenantId,
			},
			identity,
			deliveryRef: ref,
			recordedReceipt: {
				claimId: '3b6284c2-e281-43d4-bfd2-1a217279bd30',
				ref,
				sessionId: scope.sessionId,
				turnId,
				messageId: generateMessageId(),
				through: { pointer, gen: 1, bytes: 1 },
			},
			eventActorId: 'initial-actor',
			currentActorId: 'current-actor',
			context: {
				recipient: { tenantId: scope.tenantId, palId: profile.id },
				sessionId: scope.sessionId,
				profileRevision: profile.revision,
			},
		},
		action: {
			kind: 'action',
			externalTenantId: identity.externalTenantId,
			nativeConversationId: identity.nativeConversationId,
			nativeChannelId: null,
			nativeThreadId: identity.nativeThreadId,
			actorId: 'current-actor',
			eventId: 'action-event',
			actionId: 'button',
			deliveryRef: ref,
			payload,
			payloadDigest: createHash('sha256').update(payload).digest('hex'),
		},
	}
	const port = createCliPalChannelActions({
		profile,
		scope,
		paths,
		session: { resumePaused: async function* () {} },
		currentPermissionMode: () => 'prompt',
		authorize: async () => {},
	})
	return { port, context }
}

describe('authenticated channel to native review adapter', () => {
	it('takes actor and connection only from the verified route and retains stable action identity', async () => {
		const { port, context } = await fixture()
		await port.execute(context, new AbortController().signal)
		await port.execute(structuredClone(context), new AbortController().signal)
		expect(gate.execute.mock.calls[0]?.[0].actor).toEqual({
			tenantId: context.route.context.recipient.tenantId,
			actorId: 'current-actor',
			connectionId: 'connection',
		})
		expect(gate.execute.mock.calls[1]?.[0].operationId).toBe(
			gate.execute.mock.calls[0]?.[0].operationId,
		)
	})
	it('rejects a foreign triggering turn and payload identity overrides before the native gate', async () => {
		const { port, context } = await fixture()
		const body = JSON.parse(context.action.payload)
		body.waiting.turnId = generateTurnId()
		await expect(
			port.execute(
				{
					...context,
					action: {
						...context.action,
						payload: JSON.stringify(body),
						payloadDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
					},
				},
				new AbortController().signal,
			),
		).rejects.toThrow('triggering Pal')
		body.waiting.turnId = context.route.recordedReceipt.turnId
		body.actor = { actorId: 'forged' }
		await expect(
			port.execute(
				{
					...context,
					action: {
						...context.action,
						payload: JSON.stringify(body),
						payloadDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
					},
				},
				new AbortController().signal,
			),
		).rejects.toThrow()
		expect(gate.execute).not.toHaveBeenCalled()
	})
})
