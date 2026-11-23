import type { ActionFlag, ActionHelp } from '../action-help.js'

const JSON_FLAG: ActionFlag = { flag: '--json', description: 'Print JSON instead of text.' }
const ADMIN: ActionFlag = {
	flag: '--admin-password-stdin',
	description: 'Read the administrator password from the first line of standard input.',
}

export const EXTENSION_ACTIONS: readonly ActionHelp[] = [
	{
		path: ['add'],
		operands: '<file.nzx>',
		summary: 'Verify a package and show what it asks for; starts nothing.',
		flags: [JSON_FLAG],
		example: 'namzu extension add ./tracker.nzx',
	},
	{
		path: ['list'],
		summary: 'List the extensions you added and where each stands.',
		flags: [JSON_FLAG],
		example: 'namzu extension list',
	},
	{
		path: ['status'],
		operands: '<id>',
		summary: 'Say why it is or is not running, with the last audit lines.',
		flags: [JSON_FLAG],
		example: 'namzu extension status tracker',
	},
	{
		path: ['notice'],
		operands: '<id>',
		summary: 'Read the notice again, with the record of when you acknowledged it.',
		flags: [
			{ flag: '--staged', description: 'Show the notice of a staged update.' },
			{ flag: '--locale <tag>', description: 'The language to show it in.' },
			JSON_FLAG,
		],
		example: 'namzu extension notice tracker --locale tr',
	},
	{
		path: ['license'],
		operands: '<id>',
		summary: 'Enter a licence, check it again now, or release this computer’s seat.',
		flags: [
			{ flag: '--file <path>', description: 'Read the licence from a key file.' },
			{ flag: '--key-stdin', description: 'Read a key from standard input.' },
			{ flag: '--refresh', description: 'Check the licence again now.' },
			{ flag: '--release', description: 'Release this computer’s seat.' },
			ADMIN,
			JSON_FLAG,
		],
		example: 'namzu extension license tracker --file ./license.key',
	},
	{
		path: ['enable'],
		operands: '<id>',
		summary: 'Turn it on; the first time it asks you to read the notice.',
		flags: [ADMIN, JSON_FLAG],
		example: 'namzu extension enable tracker',
	},
	{
		path: ['disable'],
		operands: '<id>',
		summary: 'Turn it off; its data and your record stay.',
		flags: [ADMIN, JSON_FLAG],
		example: 'namzu extension disable tracker',
	},
	{
		path: ['unlock'],
		operands: '<id>',
		summary: 'Take the administrator lock off; needs the administrator password.',
		flags: [ADMIN, JSON_FLAG],
		example: 'namzu extension unlock tracker --admin-password-stdin',
	},
	{
		path: ['remove'],
		operands: '<id>',
		summary: 'Remove it; its data stays unless you say otherwise.',
		flags: [{ flag: '--delete-data', description: 'Delete its data too.' }, ADMIN, JSON_FLAG],
		example: 'namzu extension remove tracker --delete-data',
	},
	{
		path: ['grant'],
		operands: '<id> <permission>',
		summary: 'Allow an optional permission it asked for.',
		flags: [JSON_FLAG],
		example: 'namzu extension grant tracker network',
	},
	{
		path: ['revoke'],
		operands: '<id> <permission>',
		summary: 'Take an optional permission back.',
		flags: [ADMIN, JSON_FLAG],
		example: 'namzu extension revoke tracker network',
	},
	{
		path: ['key'],
		operands: '<id> <provider>',
		summary: 'Store a model API key for it, apart from your own keys.',
		flags: [
			{ flag: '--stdin', description: 'Read the key from standard input.' },
			{ flag: '--remove', description: 'Remove the stored key.' },
			ADMIN,
			JSON_FLAG,
		],
		example: 'namzu extension key tracker anthropic --stdin',
	},
	{
		path: ['background'],
		operands: '<id> <on|off|status>',
		summary: 'Start it when you sign in, even when Namzu is closed.',
		flags: [ADMIN, JSON_FLAG],
		example: 'namzu extension background tracker on',
	},
	{
		path: ['daemon'],
		operands: '<start|run|stop|status>',
		summary: 'Control the runner that keeps enabled extensions going (one per person).',
		flags: [ADMIN, JSON_FLAG],
		example: 'namzu extension daemon status',
	},
	{
		path: ['signin', 'remove'],
		summary: 'Remove the sign-in entry and its launcher, for an uninstaller; never data.',
		flags: [{ flag: '--all', description: 'Required: remove for every extension.' }, JSON_FLAG],
		example: 'namzu extension signin remove --all',
	},
	{
		path: ['run'],
		summary: 'Supervise every enabled extension until interrupted.',
		flags: [JSON_FLAG],
		example: 'namzu extension run',
	},
	{
		path: ['validate'],
		operands: '<folder|file>',
		summary: 'Developer check: the manifest, its rules and a package.',
		flags: [JSON_FLAG],
		example: 'namzu extension validate ./my-extension',
	},
]
