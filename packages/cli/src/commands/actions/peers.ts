import type { ActionHelp } from '../action-help.js'

const JSON_FLAG = { flag: '--json', description: 'Print JSON instead of text.' } as const

export const PEERS_ACTIONS: readonly ActionHelp[] = [
	{
		path: ['list'],
		summary:
			'List live terminals here and, when your Namzu network is on, every machine’s sessions.',
		flags: [JSON_FLAG],
		example: 'namzu peers list',
	},
	{
		path: ['send'],
		operands: '<ref|id|title|machine/name> <message...>',
		summary:
			'Queue a message in one terminal’s inbox. Exit 0 queued, 1 refused, 4 held, 69 unreachable.',
		flags: [
			JSON_FLAG,
			{ flag: '--mode <mode>', description: 'The permission mode this command acts under.' },
			{
				flag: '--file <path|->',
				description: 'Read the message from a file, or - for standard input.',
			},
		],
		example: 'namzu peers send build-box/main "Run the tests again"',
	},
	{
		path: ['status'],
		summary:
			'Say whether your Namzu network is on, how many machines are in it and what waits for you.',
		flags: [JSON_FLAG],
		example: 'namzu peers status',
	},
	{
		path: ['on'],
		summary: 'Turn your Namzu network on.',
		flags: [
			{ flag: '--anyway', description: 'Allow it on any network, not only a private one.' },
			JSON_FLAG,
		],
		example: 'namzu peers on',
	},
	{
		path: ['off'],
		summary: 'Turn your Namzu network off for good.',
		flags: [JSON_FLAG],
		example: 'namzu peers off',
	},
	{
		path: ['allow'],
		operands: '<code|name>',
		summary: 'Let a machine that asked join your network. Any machine in it can allow.',
		flags: [
			{ flag: '--trust', description: 'Also trust the network the request came from.' },
			{ flag: '--as <name>', description: 'With --trust, the name to give that network.' },
			JSON_FLAG,
		],
		example: 'namzu peers allow laptop --trust --as Home',
	},
	{
		path: ['deny'],
		operands: '<code|name>',
		summary: 'Refuse a machine that asked to join.',
		flags: [JSON_FLAG],
		example: 'namzu peers deny laptop',
	},
	{
		path: ['networks'],
		summary: 'List the networks you trust, or rename one with "networks rename <name> <new name>".',
		flags: [JSON_FLAG],
		example: 'namzu peers networks',
	},
	{
		path: ['untrust'],
		operands: '<name>',
		summary: 'Stop trusting a network, so its new machines ask for an Allow again.',
		flags: [JSON_FLAG],
		example: 'namzu peers untrust Home',
	},
	{
		path: ['remove'],
		operands: '<machine>',
		summary: 'Take a machine out of your network.',
		flags: [
			{ flag: '--and-its-admissions', description: 'Also remove the machines it let in.' },
			JSON_FLAG,
		],
		example: 'namzu peers remove laptop',
	},
	{
		path: ['rename'],
		operands: '<new name...>',
		summary: 'Rename this machine; the others show the new name.',
		flags: [JSON_FLAG],
		example: 'namzu peers rename build box',
	},
	{
		path: ['role'],
		operands: '<session|machine/> <text...>',
		summary:
			'Describe what a session, or a machine written machine/, is for. It grants no permission.',
		flags: [{ flag: '--clear', description: 'Remove the role.' }, JSON_FLAG],
		example: 'namzu peers role build-box/main "runs the tests"',
	},
	{
		path: ['add'],
		operands: '<host[:port]>',
		summary:
			'Add a machine by address, for a network where multicast does not reach (WSL2 for one).',
		flags: [JSON_FLAG],
		example: 'namzu peers add 192.168.1.20:7001',
	},
	{
		path: ['join'],
		operands: '[host[:port]]',
		summary: 'Ask the Namzu network nearby, or the machine at an address, to let this machine in.',
		flags: [JSON_FLAG],
		example: 'namzu peers join',
	},
	{
		path: ['cancel'],
		summary: 'Withdraw the request this machine is waiting on.',
		flags: [JSON_FLAG],
		example: 'namzu peers cancel',
	},
	{
		path: ['log'],
		summary: 'Show the network’s audit log: joins, removals, roles and every message decision.',
		flags: [{ flag: '-n <count>', description: 'How many entries to show.' }, JSON_FLAG],
		example: 'namzu peers log -n 20',
	},
]
