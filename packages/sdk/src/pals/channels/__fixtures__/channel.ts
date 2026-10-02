import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskSessionLog } from '../../../store/session-log/disk.js'
import type { SessionLease } from '../../../store/session-log/lease.js'
import type { SessionId } from '../../../types/ids/index.js'
import {
	generateMessageId,
	generateProjectId,
	generateTenantId,
	generateTurnId,
} from '../../../utils/id.js'
import { type PalIngressHostPort, ingressMessageRef } from '../../communication/ingress-types.js'
import { DiskPalCommunicationStore } from '../../communication/store.js'
import { DiskPalStore } from '../../store.js'
import { PalChannelIngress } from '../ingress.js'
import { DiskPalChannelRoutes } from '../routes.js'
import type { PalChannelIngressOptions, PalChannelVerifiedEvent } from '../types.js'

export async function channelFixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-channel-')))
	const pals = new DiskPalStore({
		root: join(root, 'pals'),
		workspaceRoot: join(root, 'controls'),
	})
	const first = pals.create({ name: 'First' })
	const other = pals.create({ name: 'Other' })
	const tenantId = generateTenantId()
	const projectId = generateProjectId()
	const recipient = { tenantId, palId: first.id }
	const connection = {
		tenantId,
		provider: 'local-fixture',
		connectionId: 'connection-1',
		externalTenantId: 'native-tenant-1',
	}
	const store = new DiskPalCommunicationStore({ root: join(root, 'inbox') })
	const routes = new DiskPalChannelRoutes({ root: join(root, 'routes') })
	const options: PalChannelIngressOptions = {
		connection,
		store,
		routes,
		pals,
		selectRecipient: async () => recipient,
		// This fixture is a trusted in-process verifier, not a real remote authentication scheme.
		verify: async (raw) => structuredClone(raw) as PalChannelVerifiedEvent,
		authorize: async () => ({
			allow: true,
			grant: { id: 'explicit-fixture', revision: '1' },
		}),
		now: () => 100,
	}
	const event = {
		kind: 'message' as const,
		externalTenantId: connection.externalTenantId,
		nativeConversationId: 'native-conversation',
		nativeChannelId: 'native-channel',
		nativeThreadId: 'native-thread',
		actorId: 'actor-one',
		eventId: 'event-one',
		body: 'Please review this finding.',
	}
	const logs = new Map<SessionId, { log: DiskSessionLog; lease: SessionLease }>()
	const host: PalIngressHostPort = {
		async ensureConversation(binding) {
			if (logs.has(binding.sessionId)) return
			const definition = pals.getRevision(binding.key.recipient.palId, binding.profileRevision)
			const log = new DiskSessionLog({
				sessionId: binding.sessionId,
				file: join(root, 'logs', `${binding.sessionId}.jsonl`),
				sessionDir: join(root, 'logs', binding.sessionId),
				now: () => 100,
			})
			const lease = await log.claim({
				holder: 'fixture',
				ttlMs: 60_000,
				now: 100,
			})
			if (!lease) throw new Error('Fixture claim refused.')
			await log.append(lease, {
				type: 'session_started',
				projectId,
				tenantId,
				cwd: definition.workspace,
				agent: { id: definition.id, name: definition.name },
				origin: {
					protocol: 'desktop',
					externalSessionId: JSON.stringify([
						'namzu-pal',
						definition.id,
						definition.revision,
						binding.sessionId,
					]),
				},
			})
			logs.set(binding.sessionId, { log, lease })
		},
		async openConversation(binding) {
			const owned = logs.get(binding.sessionId)
			if (!owned) throw new Error('Missing fixture log.')
			return { log: owned.log, projectId }
		},
		async runConversation() {
			throw new Error('Fixture does not run a model or a guest.')
		},
	}
	const ingress = new PalChannelIngress({ ...options, host })
	async function binding() {
		const found = (await store.readIngress(recipient))?.routes[0]
		if (!found) throw new Error('Missing fixture route.')
		return found
	}
	async function record() {
		let route = await binding()
		const signal = new AbortController().signal
		await host.ensureConversation(route, signal)
		const definition = pals.getRevision(route.key.recipient.palId, route.profileRevision)
		const access = await host.openConversation(route, signal)
		route = await store.activateIngress(route, {
			binding: route,
			access,
			definition,
		})
		const owned = logs.get(route.sessionId)
		if (!owned) throw new Error('Missing fixture writer.')
		const turnId = generateTurnId()
		await owned.log.beginTurn(owned.lease, {
			turnId,
			userMessageId: generateMessageId(),
			config: { model: 'fixture', tokenBudget: 0, timeoutMs: 60_000 },
		})
		const claimed = await store.claimIngress(route, {
			turnId,
			generation: owned.lease.fence,
			content: () => 'Verified channel context: finding.',
		})
		if (!claimed?.claim) throw new Error('Missing fixture delivery claim.')
		const messageId = generateMessageId()
		await owned.log.append(owned.lease, {
			type: 'message',
			turnId,
			messageId,
			role: 'user',
			kind: 'context',
			content: {
				role: 'user',
				content: claimed.claim.content,
				source: {
					type: 'runtime-context',
					kind: 'channel-message',
					deliveryRef: ingressMessageRef(claimed),
				},
			},
		})
		const through = await owned.log.head()
		if (!through) throw new Error('Missing fixture append head.')
		const receipt = {
			claimId: claimed.claim.id,
			ref: ingressMessageRef(claimed),
			sessionId: route.sessionId,
			turnId,
			messageId,
			through,
		}
		await store.recordedIngress(claimed, receipt, {
			binding: route,
			access,
			definition,
		})
		return {
			route,
			receipt,
			context: {
				recipient,
				sessionId: route.sessionId,
				profileRevision: route.profileRevision,
			},
		}
	}
	return {
		root,
		pals,
		first,
		other,
		recipient,
		connection,
		store,
		routes,
		options,
		event,
		host,
		ingress,
		binding,
		record,
		cleanup: async () => {
			for (const owned of logs.values()) await owned.log.release(owned.lease)
			await rm(root, { recursive: true, force: true })
		},
	}
}

export function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
