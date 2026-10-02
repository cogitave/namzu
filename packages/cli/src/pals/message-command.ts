import type { CommandContext } from '../commands/types.js'
import { EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE } from '../exit-codes.js'
import { closeSessions, openSessions } from '../integrations/sessions/store.js'
import { createFormatter } from '../output/index.js'
import { cliPalCommunicationPolicy, cliPalCommunicationStore } from './communication.js'
import { dispatchCliPalMessages } from './dispatch.js'
import { getPal } from './store.js'

async function address(palId: string) {
	const pal = getPal(palId)
	if (!pal) throw new Error('Pal does not exist.')
	const state = await openSessions(pal.workspace)
	try {
		return { tenantId: state.tenantId, palId: pal.id }
	} finally {
		closeSessions(state)
	}
}

export async function runPalMessageCommand(
	ctx: CommandContext,
	verb: string,
	args: readonly string[],
): Promise<number> {
	const positional: string[] = []
	let wake = false
	let json = false
	let revision: number | undefined
	try {
		for (let index = 0; index < args.length; index++) {
			const value = args[index]
			if (value === '--wake') {
				if (wake) throw new Error('Duplicate --wake.')
				wake = true
			} else if (value === '--json') {
				if (json) throw new Error('Duplicate --json.')
				json = true
			} else if (value === '--revision') {
				if (revision !== undefined) throw new Error('Duplicate --revision.')
				revision = Number(args[++index])
				if (!Number.isSafeInteger(revision) || revision < 0)
					throw new Error('Invalid permission revision.')
			} else if (!value || value.startsWith('--'))
				throw new Error(`Unknown Pal message option ${value}.`)
			else positional.push(value)
		}
		const expectedLength = verb === 'grant' || verb === 'revoke' ? 2 : 1
		if (positional.length !== expectedLength)
			throw new Error(`pal ${verb} requires ${expectedLength} Pal id(s).`)
		if (wake && verb !== 'grant') throw new Error('--wake belongs to pal grant.')
		if (revision !== undefined && verb !== 'grant' && verb !== 'revoke')
			throw new Error('--revision belongs to pal grant/revoke.')
		const output = json ? createFormatter('json', { quiet: false }) : ctx.formatter
		const first = await address(positional[0] as string)
		if (verb === 'grant' || verb === 'revoke') {
			const second = await address(positional[1] as string)
			const policy = cliPalCommunicationPolicy()
			const prior = await policy.get(first, second)
			output.print(
				await policy.update({
					source: first,
					recipient: second,
					expectedRevision: revision ?? prior?.revision ?? 0,
					enabled: verb === 'grant',
					allowWake: verb === 'grant' && wake,
				}),
			)
		} else if (verb === 'inbox') {
			const state = await cliPalCommunicationStore().readIngress(first)
			output.print(
				(state?.messages ?? []).map((message) => ({
					id: message.id,
					...(!('kind' in message)
						? { sourcePalId: message.source.address.palId }
						: message.kind === 'observation'
							? {
									sourceKind: 'host-observation',
									subscriptionId: message.source.subscriptionId,
									observedPalId: message.source.scope.palId,
								}
							: {
									sourceKind: 'channel',
									provider: message.source.provider,
									connectionId: message.source.connectionId,
									actorId: message.source.actorId,
								}),
					status: message.phase,
					conversationId: state?.routes.find((route) => route.id === message.routeId)?.sessionId,
				})),
			)
		} else if (verb === 'dispatch') {
			const controller = new AbortController()
			const interrupt = () => controller.abort(new Error('Pal message dispatch interrupted.'))
			process.once('SIGINT', interrupt)
			process.once('SIGTERM', interrupt)
			try {
				output.print(await dispatchCliPalMessages(ctx, first.palId, controller.signal))
			} catch (error) {
				output.error({ message: error instanceof Error ? error.message : String(error) })
				return EXIT_UNAVAILABLE
			} finally {
				process.removeListener('SIGINT', interrupt)
				process.removeListener('SIGTERM', interrupt)
			}
		} else throw new Error('Unknown Pal message command.')
		return EXIT_OK
	} catch (error) {
		ctx.formatter.error({ message: error instanceof Error ? error.message : String(error) })
		return EXIT_USAGE
	}
}
