import {
	type DurableInboundSource,
	type PalIngressDispatchOutcome,
	type PalIngressRouteBinding,
	dispatchPalIngressOnce,
	ingressAuthorizationRequest,
} from '@namzu/sdk'
import type { CommandContext } from '../commands/types.js'
import { closeSessions, loadConversation, openSessions } from '../integrations/sessions/store.js'
import { compilePermissions } from '../permissions/rules.js'
import { createAgentSession, probeAgentSession } from '../tui/agent.js'
import {
	type CliPalIngressAuthorizationOptions,
	cliPalCommunicationStore,
	createCliPalIngressAuthorization,
	createCliPalIngressHost,
} from './communication.js'
import { closeCliPalRuntime, getCliPalRuntime } from './environment.js'
import { getCliPalStore } from './store.js'
import { tuiPalPreferences, tuiPalWorkEnvironment } from './tui-session.js'

async function closeAfterWork(
	workFailure: unknown,
	operations: readonly (() => void | Promise<void>)[],
) {
	const failures: unknown[] = []
	for (const close of operations) {
		try {
			await close()
		} catch (error) {
			failures.push(error)
		}
	}
	if (!failures.length) return
	if (workFailure !== undefined) failures.unshift(workFailure)
	if (failures.length === 1) throw failures[0]
	throw new AggregateError(failures, 'Pal dispatch and cleanup failed.')
}

/** One explicit host operation. No service, automatic wake or unbounded loop is installed. */
export async function dispatchCliPalMessages(
	ctx: CommandContext,
	palId: string,
	signal: AbortSignal,
	options: CliPalIngressAuthorizationOptions = {},
): Promise<PalIngressDispatchOutcome> {
	const { authorizeChannel, operatorWake } = options
	const pals = getCliPalStore()
	const pal = pals.get(palId)
	if (!pal) throw new Error('Pal does not exist.')
	const identity = await openSessions(pal.workspace)
	const address = { tenantId: identity.tenantId, palId }
	closeSessions(identity)
	const store = cliPalCommunicationStore()
	const authorize = createCliPalIngressAuthorization({
		...(authorizeChannel ? { authorizeChannel } : {}),
		...(operatorWake ? { operatorWake } : {}),
	})
	const runConversation = async (
		binding: PalIngressRouteBinding,
		source: DurableInboundSource,
		runSignal: AbortSignal,
	) => {
		const snapshot = await store.readIngress(address)
		const envelope = snapshot?.messages.find(
			(message) => message.routeId === binding.id && message.phase !== 'recorded',
		)
		if (!envelope) throw new Error('No pending Pal message is owned by this dispatch.')
		const assertExecutionAllowed = async () => {
			runSignal.throwIfAborted()
			const decision = await authorize(ingressAuthorizationRequest(envelope, 'wake'))
			if (!decision.allow) throw new Error(`Pal execution refused: ${decision.reason}`)
		}
		await assertExecutionAllowed()
		const definition = pals.getRevision(palId, binding.profileRevision)
		const probe = await probeAgentSession()
		const preferences = tuiPalPreferences(definition, probe.preferences)
		if (!preferences) throw new Error('Choose a Pal model provider before dispatching messages.')
		await assertExecutionAllowed()
		const runtime = await getCliPalRuntime()
		if (runtime.busy(palId)) throw new Error('This Pal is busy in another conversation.')
		const state = await openSessions(definition.workspace)
		let agent: Awaited<ReturnType<typeof createAgentSession>> | undefined
		let workFailure: unknown
		try {
			const permission = compilePermissions(ctx.config.permissions, ctx.config.permissionChecks)
			if (permission.diagnostics.length)
				throw new Error(permission.diagnostics.map((item) => item.message).join('\n'))
			agent = await createAgentSession(preferences, probe.detected, {
				cwd: definition.workspace,
				conversationSessions: state,
				scope: {
					sessionId: binding.sessionId,
					tenantId: state.tenantId,
					projectId: state.projectId,
					topicId: state.topicId,
				},
				palEnvironment: await tuiPalWorkEnvironment(definition, binding.sessionId, runSignal),
				rules: permission.rules,
				permissionMode: 'strict',
				...(ctx.config.limits ? { limits: ctx.config.limits } : {}),
			})
			const messages = await loadConversation(state, binding.sessionId)
			for await (const event of agent.send(messages, {
				signal: runSignal,
				durableInbound: source,
				assertExecutionAllowed,
				permissionMode: 'strict',
			})) {
				if (event.kind === 'error') throw new Error(event.message)
				if (event.kind === 'done' && event.stopReason && event.stopReason !== 'end_turn')
					throw new Error(`Pal turn stopped: ${event.stopReason}`)
			}
		} catch (error) {
			workFailure = error
			throw error
		} finally {
			await closeAfterWork(workFailure, [() => agent?.close(), () => closeSessions(state)])
		}
	}
	let dispatchFailure: unknown
	try {
		return await dispatchPalIngressOnce(
			{
				pals,
				store,
				authorize,
				host: createCliPalIngressHost(runConversation),
			},
			address,
			signal,
		)
	} catch (error) {
		dispatchFailure = error
		throw error
	} finally {
		await closeAfterWork(dispatchFailure, [closeCliPalRuntime])
	}
}
