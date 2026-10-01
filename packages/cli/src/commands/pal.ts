/** Shared saved-Pal commands; the desktop uses these same SDK-backed records. */
import { readFileSync } from 'node:fs'
import { EXIT_USAGE } from '../exit-codes.js'
import { PROVIDER_REGISTRY } from '../integrations/providers/index.js'
import { createFormatter } from '../output/index.js'
import {
	type PalAppearance,
	type PalUpdate,
	createPal,
	getPal,
	listPals,
	updatePal,
} from '../pals/store.js'
import type { CommandDef } from './types.js'

export const PAL_HELP = [
	'Usage: namzu pal <command> [options]',
	'',
	'  list [--json]',
	'  create <name> [--purpose <text> | --purpose-file <file>] [--model <provider>/<model>] [--appearance <character>/<color>]',
	'  show <id> [--json]',
	'  update <id> [--revision <n>] [--name <name>] [--purpose <text> | --purpose-file <file>] [--model <provider>/<model>|default] [--appearance <character>/<color>]',
	'  pause <id> [--revision <n>] | resume <id> [--revision <n>]',
	'  chat <id> [--resume <conversation-id>]',
	'  grant <sender-id> <recipient-id> [--wake] [--revision <n>]',
	'  revoke <sender-id> <recipient-id> [--revision <n>]',
	'  inbox <id> [--json]',
	'  dispatch <id> [--json]',
	'',
	'A Pal keeps its identity and immutable profile revisions across conversations.',
	'Chat requires a ready local virtual computer; no host-folder execution fallback.',
	'Profile edits affect new conversations. Existing conversations retain their original profile.',
	'Appearance characters: pixel, sprout, spark. Colors: green, blue, amber, violet, rose.',
	'Messaging is denied until a directed grant exists. --wake also permits explicit dispatch.',
	'Dispatch runs one owned inbox route with preapproved tools; no background listener is installed.',
].join('\n')
function argumentsFor(args: readonly string[]) {
	const positional: string[] = []
	const values = new Map<string, string>()
	let json = false
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === undefined) throw new Error('Missing Pal argument.')
		if (arg === '--json') {
			json = true
			continue
		}
		if (!arg.startsWith('--')) {
			positional.push(arg)
			continue
		}
		if (
			!['--name', '--purpose', '--purpose-file', '--model', '--revision', '--appearance'].includes(
				arg,
			)
		)
			throw new Error(`Unknown Pal option ${arg}.`)
		const value = args[++index]
		if (value === undefined || value.startsWith('--') || values.has(arg))
			throw new Error(`Expected one value for ${arg}.`)
		values.set(arg, value)
	}
	if (values.has('--purpose') && values.has('--purpose-file'))
		throw new Error('Use either --purpose or --purpose-file.')
	return { positional, values, json }
}
function model(value: string) {
	if (value === 'default') return null
	const slash = value.indexOf('/')
	if (slash < 1 || slash === value.length - 1) throw new Error('Use --model provider/model.')
	const provider = value.slice(0, slash)
	if (!Object.hasOwn(PROVIDER_REGISTRY, provider)) throw new Error('Unknown Pal model provider.')
	return { provider, model: value.slice(slash + 1) }
}
function appearance(value: string): PalAppearance {
	const [character, color, extra] = value.split('/')
	if (
		extra !== undefined ||
		(character !== 'pixel' && character !== 'sprout' && character !== 'spark') ||
		(color !== 'green' &&
			color !== 'blue' &&
			color !== 'amber' &&
			color !== 'violet' &&
			color !== 'rose')
	)
		throw new Error('Use --appearance pixel|sprout|spark/green|blue|amber|violet|rose.')
	return { character, color }
}
export function createPalCommand(resumeCommand?: readonly [string, ...string[]]): CommandDef {
	return {
		name: 'pal',
		description: 'Create and operate persistent Pals with their own local virtual computers',
		passThrough: true,
		help: PAL_HELP,
		handler: async ({ ctx, rawArgs }) => {
			try {
				const [verb, ...rest] = rawArgs
				if (verb === 'grant' || verb === 'revoke' || verb === 'inbox' || verb === 'dispatch')
					return (await import('../pals/message-command.js')).runPalMessageCommand(ctx, verb, rest)
				if (verb === 'chat') {
					const [id, ...args] = rest
					if (!id) throw new Error('A Pal id is required.')
					return (await import('../pals/chat.js')).runPalChat(ctx, id, args, { resumeCommand })
				}
				const { positional, values, json } = argumentsFor(rest)
				const output = json ? createFormatter('json', { quiet: false }) : ctx.formatter
				if (verb === 'list') {
					if (positional.length || values.size) throw new Error('pal list accepts only --json.')
					output.print(listPals())
					return 0
				}
				const value = positional[0]
				if (positional.length !== 1 || value === undefined)
					throw new Error('Exactly one Pal name or id is required.')
				if (verb === 'show') {
					if (values.size) throw new Error('pal show accepts only --json.')
					const pal = getPal(value)
					if (!pal) throw new Error('Pal does not exist.')
					output.print(pal)
					return 0
				}
				const purposeFile = values.get('--purpose-file')
				const nameChoice = values.get('--name')
				const modelChoice = values.get('--model')
				const appearanceChoice = values.get('--appearance')
				const purpose =
					values.get('--purpose') ??
					(purposeFile === undefined ? undefined : readFileSync(purposeFile, 'utf8'))
				const selectedModel = modelChoice === undefined ? undefined : model(modelChoice)
				const selectedAppearance =
					appearanceChoice === undefined ? undefined : appearance(appearanceChoice)
				if (verb === 'create') {
					if (values.has('--revision') || values.has('--name'))
						throw new Error('pal create takes its name as an argument.')
					output.print(
						createPal({
							name: value,
							...(purpose === undefined ? {} : { purpose }),
							...(selectedModel === undefined ? {} : { model: selectedModel }),
							...(selectedAppearance === undefined ? {} : { appearance: selectedAppearance }),
						}),
					)
					return 0
				}
				if (!['update', 'pause', 'resume'].includes(verb ?? ''))
					throw new Error('Choose list, create, show, update, pause, resume or chat.')
				const pal = getPal(value)
				if (!pal) throw new Error('Pal does not exist.')
				const revision = values.has('--revision') ? Number(values.get('--revision')) : pal.revision
				if (!Number.isSafeInteger(revision) || revision < 1)
					throw new Error('Invalid Pal revision.')
				if (verb !== 'update' && [...values.keys()].some((key) => key !== '--revision'))
					throw new Error(`pal ${verb} accepts only --revision and --json.`)
				const changes: PalUpdate =
					verb === 'pause'
						? { paused: true }
						: verb === 'resume'
							? { paused: false }
							: {
									...(nameChoice === undefined ? {} : { name: nameChoice }),
									...(purpose === undefined ? {} : { purpose }),
									...(selectedModel === undefined ? {} : { model: selectedModel }),
									...(selectedAppearance === undefined ? {} : { appearance: selectedAppearance }),
								}
				if (!Object.keys(changes).length) throw new Error('Choose a field to update.')
				output.print(updatePal(value, revision, changes))
				return 0
			} catch (error) {
				ctx.formatter.error({ message: error instanceof Error ? error.message : String(error) })
				return EXIT_USAGE
			}
		},
	}
}
export const palCommand = createPalCommand()
