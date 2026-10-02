import type { CommandContext } from '../commands/types.js'
import { EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE } from '../exit-codes.js'
import { createFormatter } from '../output/index.js'
import { publishCliPalActivity, subscribeCliPalActivity } from './activity.js'
import {
	cliPalActivitySubscriptionPolicy,
	cliPalActivitySubscriptionStore,
} from './communication.js'

export async function runPalActivityCommand(
	ctx: CommandContext,
	verb: string,
	args: readonly string[],
): Promise<number> {
	const positional: string[] = []
	const flags = new Set<string>()
	const values = new Map<string, number>()
	try {
		for (let index = 0; index < args.length; index++) {
			const value = args[index]
			if (!value) throw new Error('Missing Pal activity argument.')
			if (value === '--json' || value === '--wake') {
				if (flags.has(value)) throw new Error(`Duplicate ${value}.`)
				flags.add(value)
			} else if (
				[
					'--revision',
					'--max-records',
					'--max-bytes',
					'--causality-bytes',
					'--causality-records',
				].includes(value)
			) {
				const text = args[++index]
				if (!text || !/^[1-9][0-9]*$/u.test(text) || values.has(value))
					throw new Error(`Expected one positive integer for ${value}.`)
				const number = Number(text)
				if (!Number.isSafeInteger(number)) throw new Error(`Invalid ${value}.`)
				values.set(value, number)
			} else if (value.startsWith('-')) throw new Error(`Unknown Pal activity option ${value}.`)
			else positional.push(value)
		}
		if (!['subscribe', 'subscription', 'activity', 'unsubscribe'].includes(verb))
			throw new Error('Unknown Pal activity command.')
		if (positional.length !== (verb === 'subscribe' ? 3 : 1))
			throw new Error(
				verb === 'subscribe'
					? 'pal subscribe requires source Pal, source conversation and recipient Pal ids.'
					: `pal ${verb} requires one subscription id.`,
			)
		if (flags.has('--wake') && verb !== 'subscribe')
			throw new Error('--wake belongs to pal subscribe.')
		for (const key of values.keys()) {
			if (
				(key === '--revision' && verb !== 'unsubscribe') ||
				(key !== '--revision' && verb !== 'activity')
			)
				throw new Error(`${key} does not belong to pal ${verb}.`)
		}
		if (
			(values.get('--max-records') ?? 64) > 256 ||
			(values.get('--max-bytes') ?? 1024 * 1024) > 16 * 1024 * 1024
		)
			throw new Error('A page permits at most 256 records and 16 MiB of original journal reads.')
	} catch (error) {
		ctx.formatter.error({
			message: error instanceof Error ? error.message : String(error),
		})
		return EXIT_USAGE
	}
	const output = flags.has('--json') ? createFormatter('json', { quiet: false }) : ctx.formatter
	const controller = new AbortController()
	const interrupt = () => controller.abort(new Error('Pal activity command interrupted.'))
	process.once('SIGINT', interrupt)
	process.once('SIGTERM', interrupt)
	try {
		const id = positional[0] as string
		if (verb === 'subscribe') {
			output.print(
				await subscribeCliPalActivity({
					sourcePalId: id,
					sourceSessionId: positional[1] as string,
					recipientPalId: positional[2] as string,
					wake: flags.has('--wake'),
					signal: controller.signal,
				}),
			)
		} else if (verb === 'activity') {
			output.print(
				await publishCliPalActivity({
					subscriptionId: id,
					signal: controller.signal,
					maxRecords: values.get('--max-records') ?? 64,
					maxReadBytes: values.get('--max-bytes') ?? 1024 * 1024,
					causalityReadBytes: values.get('--causality-bytes') ?? 16 * 1024 * 1024,
					causalityRecords: values.get('--causality-records') ?? 100_000,
				}),
			)
		} else {
			const subscriptions = cliPalActivitySubscriptionStore()
			const subscription = await subscriptions.get(id)
			if (!subscription) throw new Error('Unknown Pal activity subscription.')
			output.print(
				verb === 'unsubscribe'
					? await subscriptions.setEnabled({
							id,
							expectedRevision: values.get('--revision') ?? subscription.revision,
							enabled: false,
						})
					: {
							subscription,
							permission: await cliPalActivitySubscriptionPolicy().get(id),
						},
			)
		}
		return EXIT_OK
	} catch (error) {
		output.error({
			message: error instanceof Error ? error.message : String(error),
		})
		return EXIT_UNAVAILABLE
	} finally {
		process.removeListener('SIGINT', interrupt)
		process.removeListener('SIGTERM', interrupt)
	}
}
