import { join } from 'node:path'
import {
	DiskPalChannelRoutes,
	DiskPalCommunicationStore,
	DiskSessionLog,
	PalChannelIngress,
	type PalChannelIngressOptions,
	PalChannelRouter,
	type PalChannelRouterOptions,
	type PalIngressHostPort,
	createPalIngressInboxSource,
} from '@namzu/sdk'
import { restrictToOwner } from '../integrations/providers/credential-store.js'
import { closeSessions, openSessions } from '../integrations/sessions/store.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { claimPalConversation } from './conversations.js'
import { getCliPalStore } from './store.js'

export interface CliPalChannelOptions {
	readonly connection: PalChannelIngressOptions['connection']
	readonly verify: PalChannelIngressOptions['verify']
	readonly selectRecipient: PalChannelIngressOptions['selectRecipient']
	readonly authorize: PalChannelIngressOptions['authorize']
	readonly authorizeRoute: PalChannelRouterOptions['authorize']
	readonly runConversation?: PalIngressHostPort['runConversation']
	readonly actions?: PalChannelRouterOptions['actions']
}

/** Trusted local composition. A renderer/raw event cannot select credentials, tenant or Pal. */
export function createCliPalChannel(input: CliPalChannelOptions) {
	const options = Object.freeze({ ...input })
	const connection = Object.freeze({ ...options.connection })
	const pals = getCliPalStore()
	const store = new DiskPalCommunicationStore({
		root: join(resolveNamzuHome(), 'pal-message-inbox'),
		secureDirectory: restrictToOwner,
	})
	const routes = new DiskPalChannelRoutes({
		root: join(resolveNamzuHome(), 'pal-channel-routes'),
		secureDirectory: restrictToOwner,
	})
	const host: PalIngressHostPort = {
		async ensureConversation(binding, signal) {
			signal.throwIfAborted()
			const definition = pals.getRevision(binding.key.recipient.palId, binding.profileRevision)
			const state = await openSessions(definition.workspace)
			try {
				if (state.tenantId !== binding.key.recipient.tenantId)
					throw new Error('Foreign channel Pal conversation tenant.')
			} finally {
				closeSessions(state)
			}
			await claimPalConversation(
				definition.workspace,
				definition.id,
				binding.sessionId,
				binding.profileRevision,
			)
			signal.throwIfAborted()
		},
		async openConversation(binding, signal) {
			signal.throwIfAborted()
			const definition = pals.getRevision(binding.key.recipient.palId, binding.profileRevision)
			const state = await openSessions(definition.workspace)
			try {
				if (state.tenantId !== binding.key.recipient.tenantId)
					throw new Error('Foreign channel Pal conversation tenant.')
				return {
					projectId: state.projectId,
					log: DiskSessionLog.at(state.paths, { sessionId: binding.sessionId }),
				}
			} finally {
				closeSessions(state)
			}
		},
		async runConversation(binding, source, signal) {
			if (!options.runConversation)
				throw new Error('This channel host has no explicit Pal execution dispatcher.')
			await options.runConversation(binding, source, signal)
		},
	}
	const ingress = new PalChannelIngress({
		...options,
		connection,
		pals,
		store,
		routes,
		host,
	})
	const router = new PalChannelRouter({
		connection,
		verify: options.verify,
		pals,
		store,
		host,
		authorize: options.authorizeRoute,
		actions: options.actions,
	})
	const source = (binding: Parameters<typeof createPalIngressInboxSource>[0]['binding']) =>
		createPalIngressInboxSource({
			binding,
			pals,
			store,
			host,
			async authorize(request) {
				if (
					!('kind' in request) ||
					request.kind !== 'channel' ||
					request.source.tenantId !== connection.tenantId ||
					request.source.provider !== connection.provider ||
					request.source.connectionId !== connection.connectionId ||
					request.source.externalTenantId !== connection.externalTenantId
				)
					return {
						allow: false,
						reason:
							'This authenticated channel host cannot authorize another input family or connection.',
					}
				return options.authorize(request)
			},
		})
	return { ingress, router, source, store, routes, host }
}
