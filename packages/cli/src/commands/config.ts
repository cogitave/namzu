import { createInterface } from 'node:readline'

import {
	SETTING_SECTIONS,
	findSetting,
	isSettingSection,
	listSettings,
	planSettingChange,
	readSettingRow,
	renderSetting,
	renderSettingList,
	rowData,
	unknownSettingMessage,
} from '../config/setting-cli.js'
import { userConfigPath } from '../config/user-config.js'
import type { CommandDef } from './types.js'

/** Usage mistakes exit 2 here; a refused or failed change exits 1. */
const EXIT_REFUSED = 1
const EXIT_USAGE_CONFIG = 2

const HELP = [
	'Usage:',
	'  namzu config list [--section <name>] [--json]',
	'  namzu config get <key> [--json]',
	'  namzu config set <key> <value> [--yes]',
	'  namzu config unset <key> [--yes]      (also: reset)',
	'',
	'Read and change the settings Desktop shows, in your user config file. Desktop and this',
	'command use one description of each setting, so the same value is accepted or refused',
	'with the same words in both. Only the user file is written, never a project file.',
	'',
	'A value is read by what the setting is: on/off, a number (a time takes 5m or 90s, a size',
	'takes 200k or 1m), one of its choices by value or plain name, a comma list, text, or JSON.',
	'A setting that widens what runs asks first; without a terminal it is refused unless you',
	'pass --yes.',
	'',
	`Sections: ${SETTING_SECTIONS.join(', ')}`,
	'',
	'Options:',
	'  --section <name>  List one section only',
	'  --json            Print data instead of text',
	'  --yes, -y         Answer the question a risky change asks',
	'',
	'Exit codes: 0 done, 1 refused or failed, 2 usage.',
].join('\n')

interface Parsed {
	readonly positional: string[]
	readonly json: boolean
	readonly yes: boolean
	readonly section?: string
	readonly error?: string
}

export function parseConfigArgs(rawArgs: readonly string[]): Parsed {
	const positional: string[] = []
	let json = false
	let yes = false
	let section: string | undefined
	for (let index = 0; index < rawArgs.length; index++) {
		const arg = rawArgs[index] as string
		if (arg === '--json') json = true
		else if (arg === '--yes' || arg === '-y') yes = true
		else if (arg === '--section') {
			const next = rawArgs[index + 1]
			if (next === undefined || next.startsWith('--'))
				return { positional, json, yes, error: '--section needs a section name' }
			section = next
			index++
		} else if (arg.startsWith('--section=')) section = arg.slice('--section='.length)
		else if (arg.startsWith('--')) return { positional, json, yes, error: `unknown option: ${arg}` }
		else positional.push(arg)
	}
	return { positional, json, yes, ...(section !== undefined ? { section } : {}) }
}

function say(text: string): void {
	process.stdout.write(`${text}\n`)
}

function complain(text: string): void {
	process.stderr.write(`${text}\n`)
}

function askYesNo(question: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stderr })
		rl.question(`${question} [y/N] `, (answer) => {
			rl.close()
			resolve(/^y(es)?$/i.test(answer.trim()))
		})
	})
}

/** A value that a shell would split or expand is single-quoted, so the hint can be pasted. */
export function shellWord(text: string): string {
	return /^[A-Za-z0-9._-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`
}

async function change(key: string, text: string | undefined, yes: boolean): Promise<number> {
	const plan = planSettingChange(key, text)
	if (!plan.ok) {
		complain(plan.error)
		return EXIT_REFUSED
	}
	if (plan.confirm && !yes) {
		if (process.stdin.isTTY && process.stderr.isTTY) {
			if (!(await askYesNo(plan.confirm))) {
				complain('Not changed.')
				return EXIT_REFUSED
			}
		} else {
			complain(plan.confirm)
			complain(
				`Not changed. There is no terminal to ask on; to make this change, run it again with --yes: namzu config ${text === undefined ? 'unset' : 'set'} ${key}${text === undefined ? '' : ` ${shellWord(text)}`} --yes`,
			)
			return EXIT_REFUSED
		}
	}
	try {
		say(plan.apply())
	} catch (error) {
		complain((error as Error).message)
		return EXIT_REFUSED
	}
	return 0
}

export const configCommand: CommandDef = {
	name: 'config',
	description: 'List, read and change the settings Desktop shows, in your user config file',
	passThrough: true,
	help: HELP,
	handler: async ({ rawArgs }) => {
		const flags = parseConfigArgs(rawArgs)
		const usage = (message: string): number => {
			complain(`${message}\nRun namzu config --help for usage.`)
			return EXIT_USAGE_CONFIG
		}
		if (flags.error) return usage(flags.error)
		const [action, ...rest] = flags.positional
		try {
			switch (action) {
				case 'list': {
					if (rest.length > 0) return usage('namzu config list takes no arguments')
					if (flags.section !== undefined && !isSettingSection(flags.section))
						return usage(`unknown section ${flags.section}; one of ${SETTING_SECTIONS.join(', ')}`)
					const { file, rows } = listSettings(
						{},
						flags.section as (typeof SETTING_SECTIONS)[number] | undefined,
					)
					if (flags.json) say(JSON.stringify({ file, settings: rows.map(rowData) }))
					else say(renderSettingList(rows, file))
					return 0
				}
				case 'get': {
					if (rest.length !== 1) return usage('namzu config get takes one key')
					const key = rest[0] as string
					if (!findSetting(key)) {
						complain(unknownSettingMessage(key))
						return EXIT_REFUSED
					}
					const row = readSettingRow(key)
					say(
						flags.json
							? JSON.stringify({ file: userConfigPath(), ...rowData(row) })
							: renderSetting(row, userConfigPath()),
					)
					return 0
				}
				case 'set': {
					if (rest.length < 2) return usage('namzu config set takes a key and a value')
					const [key, ...words] = rest as [string, ...string[]]
					return await change(key, words.join(' '), flags.yes)
				}
				case 'unset':
				case 'reset': {
					if (rest.length !== 1) return usage(`namzu config ${action} takes one key`)
					return await change(rest[0] as string, undefined, flags.yes)
				}
				default:
					return usage(
						action === undefined
							? 'namzu config needs list, get, set or unset'
							: `unknown config command: ${action}`,
					)
			}
		} catch (error) {
			complain((error as Error).message)
			return EXIT_REFUSED
		}
	},
}
