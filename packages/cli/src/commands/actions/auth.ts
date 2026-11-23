import type { ActionHelp } from '../action-help.js'

export const AUTH_ACTIONS: readonly ActionHelp[] = [
	{
		path: ['login'],
		operands: '<claude|codex>',
		summary: 'Sign in with a provider subscription.',
		flags: [
			{ flag: '--no-browser', description: 'Do not open a browser; print the address.' },
			{
				flag: '--code <value>',
				description: 'Finish a waiting Claude sign-in with its code or finished address.',
			},
			{
				flag: '--timeout <seconds>',
				description: 'Give up waiting after this long (default 300).',
			},
		],
		example: 'namzu auth login claude --no-browser',
	},
	{
		path: ['logout'],
		operands: '[provider|all]',
		summary: 'Remove the credentials Namzu stored (all of them when no provider is named).',
		example: 'namzu auth logout codex',
	},
	{
		path: ['status'],
		summary: 'List each stored or detected credential. Exit 0 when one is usable, 1 when none is.',
		flags: [{ flag: '--json', description: 'Print the list as a JSON array.' }],
		example: 'namzu auth status --json',
	},
]
