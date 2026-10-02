/** Finite local operator subscriptions over original Pal journals and the shared SDK inbox. */
import { randomUUID } from 'node:crypto'
import {
	DiskLogMedium,
	DiskSessionLog,
	type PalActivityScope,
	type PalActivitySourceOptions,
	createPalActivityCausalityResolver,
	createPalActivitySource,
	publishPalActivityOnce,
} from '@namzu/sdk'
import { closeSessions, openSessions } from '../integrations/sessions/store.js'
import {
	cliPalActivitySubscriptionPolicy,
	cliPalActivitySubscriptionStore,
	cliPalCommunicationStore,
	createCliPalIngressHost,
} from './communication.js'
import { palConversationBinding } from './conversations.js'
import { getCliPalStore, getPal } from './store.js'

/** Resolve the exact original journal. Neither a renderer nor a model supplies its path. */
const openJournal: PalActivitySourceOptions['openJournal'] = async (scope, signal) => {
	signal.throwIfAborted()
	const definition = getCliPalStore().getRevision(scope.palId, scope.profileRevision)
	const state = await openSessions(definition.workspace)
	try {
		if (state.tenantId !== scope.tenantId || state.projectId !== scope.projectId)
			throw new Error('Foreign Pal observation scope.')
		const log = DiskSessionLog.at(state.paths, { sessionId: scope.sessionId })
		signal.throwIfAborted()
		return { log, bytes: new DiskLogMedium(log.file) }
	} finally {
		closeSessions(state)
	}
}

/** Only a direct, explicit operator command creates these grants. No automatic discovery. */
export async function subscribeCliPalActivity(input: {
	readonly sourcePalId: string
	readonly sourceSessionId: string
	readonly recipientPalId: string
	readonly wake: boolean
	readonly signal: AbortSignal
}) {
	input.signal.throwIfAborted()
	const source = getPal(input.sourcePalId)
	const recipient = getPal(input.recipientPalId)
	if (!source || !recipient) throw new Error('Source and recipient Pals must exist.')
	const binding = await palConversationBinding(source.workspace, input.sourceSessionId)
	if (!binding || binding.pal.id !== source.id)
		throw new Error('Observation requires an original conversation owned by the source Pal.')
	const state = await openSessions(source.workspace)
	let scope: PalActivityScope
	try {
		scope = {
			tenantId: state.tenantId,
			projectId: state.projectId,
			palId: source.id,
			profileRevision: binding.definition.revision,
			sessionId: binding.sessionId,
		}
	} finally {
		closeSessions(state)
	}
	const destination = await openSessions(recipient.workspace)
	try {
		if (destination.tenantId !== scope.tenantId)
			throw new Error('Pal observations cannot cross tenant ownership.')
	} finally {
		closeSessions(destination)
	}
	// This command is the observation authorization. The original reader still validates the
	// immutable root, profile, cwd and absence of child/fork lineage before anything is saved.
	await createPalActivitySource({
		scope,
		pals: getCliPalStore(),
		openJournal,
		authorize: async () => true,
	}).read({ signal: input.signal, maxRecords: 1, maxReadBytes: 1024 * 1024 })
	input.signal.throwIfAborted()
	const subscriptions = cliPalActivitySubscriptionStore()
	const pending = await subscriptions.create({
		id: randomUUID(),
		scope,
		recipient: { tenantId: scope.tenantId, palId: recipient.id },
		enabled: false,
	})
	await cliPalActivitySubscriptionPolicy().update({
		subscriptionId: pending.id,
		expectedRevision: 0,
		observe: true,
		disclose: true,
		receive: true,
		wake: input.wake,
	})
	input.signal.throwIfAborted()
	return subscriptions.setEnabled({
		id: pending.id,
		expectedRevision: pending.revision,
		enabled: true,
	})
}

/** One bounded page, no model invocation, guest startup or implicit wake. */
export async function publishCliPalActivity(input: {
	readonly subscriptionId: string
	readonly signal: AbortSignal
	readonly maxRecords: number
	readonly maxReadBytes: number
	readonly causalityReadBytes: number
	readonly causalityRecords: number
}) {
	const subscriptions = cliPalActivitySubscriptionStore()
	const subscription = await subscriptions.get(input.subscriptionId)
	if (!subscription) throw new Error('Unknown Pal activity subscription.')
	const policy = cliPalActivitySubscriptionPolicy()
	const ingress = cliPalCommunicationStore()
	const host = createCliPalIngressHost()
	const resolveCausality = createPalActivityCausalityResolver({
		pals: getCliPalStore(),
		ingress,
		openJournal,
		maxReadBytes: input.causalityReadBytes,
		maxRecords: input.causalityRecords,
		async authorize() {
			return (await policy.authorizeSubscription({ phase: 'observe', subscription })).allow
		},
	})
	return publishPalActivityOnce(
		{
			subscriptions,
			ingress,
			pals: getCliPalStore(),
			openJournal,
			resolveCausality,
			authorize: (request) => policy.authorizeSubscription(request),
			notify: () => host.notify?.(subscription.recipient),
		},
		input.subscriptionId,
		{
			signal: input.signal,
			maxRecords: input.maxRecords,
			maxReadBytes: input.maxReadBytes,
		},
	)
}
