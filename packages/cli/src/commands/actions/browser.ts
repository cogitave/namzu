import type { ActionHelp } from '../action-help.js'

const HOME = {
	flag: '--home <dir>',
	description: 'Use this Namzu home instead of NAMZU_HOME.',
} as const

export const BROWSER_ACTIONS: readonly ActionHelp[] = [
	{
		path: ['login'],
		operands: '<profile> [url]',
		summary: 'Open a visible window on a profile so you can sign in; the agent reuses the sign-in.',
		flags: [HOME],
		example: 'namzu browser login work example.com',
	},
	{
		path: ['list'],
		summary: 'List the profiles, their browser and last sign-in.',
		flags: [HOME, { flag: '--json', description: 'Print JSON instead of text.' }],
		example: 'namzu browser list',
	},
	{
		path: ['status'],
		operands: '[profile]',
		summary: 'Say which browser runs here, and show one profile in detail.',
		flags: [HOME, { flag: '--json', description: 'Print JSON instead of text.' }],
		example: 'namzu browser status work',
	},
	{
		path: ['install'],
		summary: 'Download the Chromium the browser tools use (not needed when Chrome is installed).',
		flags: [
			{ flag: '--dry-run', description: 'Say what would be downloaded and download nothing.' },
			{ flag: '--force', description: 'Download even when a browser is found.' },
		],
		example: 'namzu browser install --dry-run',
	},
	{
		path: ['remove'],
		operands: '<profile>',
		summary: 'Delete a profile and everything signed in to it.',
		flags: [HOME, { flag: '--yes', description: 'Do not ask first.' }],
		example: 'namzu browser remove work --yes',
	},
]
