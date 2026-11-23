import type { ActionFlag, ActionHelp } from '../action-help.js'

const JSON_FLAG: ActionFlag = { flag: '--json', description: 'Print JSON instead of text.' }
const REVISION: ActionFlag = {
	flag: '--revision <n>',
	description: 'Only act if the Pal is still at this revision.',
}
const WAKE: ActionFlag = { flag: '--wake', description: 'Also allow explicit dispatch.' }
const PROFILE: readonly ActionFlag[] = [
	{ flag: '--purpose <text>', description: 'What the Pal is for.' },
	{
		flag: '--purpose-file <file>',
		description: 'Read the purpose from a file (not with --purpose).',
	},
	{ flag: '--model <provider>/<model>', description: 'The model the Pal uses.' },
	{
		flag: '--appearance <character>/<color>',
		description: 'pixel, sprout or spark; green, blue, amber, violet or rose.',
	},
]

export const PAL_ACTIONS: readonly ActionHelp[] = [
	{
		path: ['list'],
		summary: 'List your Pals.',
		flags: [JSON_FLAG],
		example: 'namzu pal list',
	},
	{
		path: ['create'],
		operands: '<name>',
		summary: 'Create a Pal with its own local virtual computer.',
		flags: PROFILE,
		example: 'namzu pal create scout --purpose "Watch the build" --appearance spark/blue',
	},
	{
		path: ['show'],
		operands: '<id>',
		summary: 'Show one Pal and its current profile.',
		flags: [JSON_FLAG],
		example: 'namzu pal show scout',
	},
	{
		path: ['update'],
		operands: '<id>',
		summary: 'Change a Pal’s profile; it applies to new conversations only.',
		flags: [REVISION, { flag: '--name <name>', description: 'A new name.' }, ...PROFILE],
		example: 'namzu pal update scout --model default',
	},
	{
		path: ['pause'],
		operands: '<id>',
		summary: 'Pause a Pal.',
		flags: [REVISION],
		example: 'namzu pal pause scout',
	},
	{
		path: ['resume'],
		operands: '<id>',
		summary: 'Resume a paused Pal.',
		flags: [REVISION],
		example: 'namzu pal resume scout',
	},
	{
		path: ['chat'],
		operands: '<id>',
		summary: 'Open a conversation with a Pal; it needs a ready local virtual computer.',
		flags: [{ flag: '--resume <conversation-id>', description: 'Continue this conversation.' }],
		example: 'namzu pal chat scout',
	},
	{
		path: ['grant'],
		operands: '<sender-id> <recipient-id>',
		summary: 'Let one Pal message another; messaging is denied until a grant exists.',
		flags: [WAKE, REVISION],
		example: 'namzu pal grant scout builder --wake',
	},
	{
		path: ['revoke'],
		operands: '<sender-id> <recipient-id>',
		summary: 'Take a messaging grant back.',
		flags: [REVISION],
		example: 'namzu pal revoke scout builder',
	},
	{
		path: ['inbox'],
		operands: '<id>',
		summary: 'Show the messages waiting for a Pal.',
		flags: [JSON_FLAG],
		example: 'namzu pal inbox builder',
	},
	{
		path: ['dispatch'],
		operands: '<id>',
		summary: 'Run one owned inbox route with preapproved tools; nothing runs in the background.',
		flags: [JSON_FLAG],
		example: 'namzu pal dispatch builder',
	},
	{
		path: ['subscribe'],
		operands: '<source-pal-id> <source-conversation-id> <recipient-pal-id>',
		summary: 'Let a Pal see closed activity metadata of another Pal’s conversation.',
		flags: [WAKE, JSON_FLAG],
		example: 'namzu pal subscribe scout 3f2a9c builder',
	},
	{
		path: ['subscription'],
		operands: '<subscription-id>',
		summary: 'Show one subscription.',
		flags: [JSON_FLAG],
		example: 'namzu pal subscription sub-1',
	},
	{
		path: ['activity'],
		operands: '<subscription-id>',
		summary:
			'Publish one bounded page of the activity journal, without inference or guest startup.',
		flags: [
			{ flag: '--max-records <n>', description: 'At most this many records.' },
			{ flag: '--max-bytes <n>', description: 'At most this many bytes.' },
			{ flag: '--causality-bytes <n>', description: 'Byte limit for causality records.' },
			{ flag: '--causality-records <n>', description: 'Record limit for causality records.' },
			JSON_FLAG,
		],
		example: 'namzu pal activity sub-1 --max-records 50',
	},
	{
		path: ['unsubscribe'],
		operands: '<subscription-id>',
		summary: 'End a subscription.',
		flags: [REVISION, JSON_FLAG],
		example: 'namzu pal unsubscribe sub-1',
	},
]
