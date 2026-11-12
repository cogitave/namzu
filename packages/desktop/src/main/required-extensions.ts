/**
 * The methods a host must list in its `initialize` answer for the app to use it at all. One list,
 * read by the connection that starts a host and by the check that runs a fetched engine before it
 * is kept, so the two can never disagree about what a usable engine is.
 */
export const REQUIRED_EXTENSIONS = [
	'namzu/project/status',
	'namzu/project/trust',
	'namzu/conversations/list',
	'namzu/conversations/history',
	'namzu/providers/status',
	'namzu/providers/select',
	'namzu/jobs/list',
	'namzu/jobs/read',
	'namzu/jobs/stop',
] as const
