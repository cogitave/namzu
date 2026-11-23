import { EXIT_USAGE } from '../exit-codes.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import { PROVIDERS_ACTIONS } from './actions/small.js'
import { collectProviders } from './host-queries.js'
import type { CommandDef } from './types.js'

const HELP = [
	'Usage: namzu providers list [--json]',
	'',
	'List every provider Namzu can talk to, whether one was found on this',
	'machine, its default model and the models it offers.',
	'',
	'Options:',
	'  --json  Print one JSON array of {provider, label, detected, default, models}',
	'          for a host UI; an empty array means discovery failed',
].join('\n')

export const providersCommand: CommandDef = {
	name: 'providers',
	description: 'List providers and their models',
	passThrough: true,
	help: HELP,
	actions: PROVIDERS_ACTIONS,
	handler: async ({ ctx, rawArgs }) => {
		if (rawArgs[0] !== 'list') {
			const given = rawArgs[0] === undefined || rawArgs[0].startsWith('-') ? undefined : rawArgs[0]
			ctx.formatter.error({
				message:
					given === undefined
						? 'A providers command is required: `namzu providers list`.'
						: `Unknown providers command \`${given}\`. Use \`namzu providers list\`.`,
			})
			return EXIT_USAGE
		}
		const rest = rawArgs.slice(1)
		const json = rest.includes('--json')
		const unknown = rest.find((a) => a !== '--json')
		if (unknown !== undefined) {
			ctx.formatter.error({ message: `unknown providers option or argument: ${unknown}` })
			return EXIT_USAGE
		}
		const rows = await collectProviders(ctx)
		if (json) {
			process.stdout.write(`${JSON.stringify(rows)}\n`)
			return 0
		}
		const one = (v: string) => terminalDisplayText(v).replace(/[\t\n\r]+/g, ' ')
		const lines = ['Providers:']
		for (const r of rows) {
			const models = r.models.length > 0 ? `${r.models.length} models` : 'no model list'
			lines.push(
				`  ${one(r.provider).padEnd(16)} ${r.detected ? 'found    ' : 'not found'}  default ${one(r.default)}  (${models})`,
			)
		}
		if (rows.length === 0) lines.push('  none could be listed')
		ctx.formatter.print({ providers: rows, text: lines.join('\n') })
		return 0
	},
}
