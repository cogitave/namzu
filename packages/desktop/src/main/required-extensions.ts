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

/**
 * What the app tells a host in `initialize`. One shape, sent by the connection that starts a host and
 * by the check that runs a fetched engine, and recorded in packages/cli/desktop-contract/inventory.json.
 */
export const DESKTOP_CLIENT_NAME = 'namzu-desktop'
export const DESKTOP_CLIENT_CAPABILITIES = ['permission', 'namzu/tasks'] as const

/**
 * Named at `initialize` only when the app can host the agent's browser in its Browser pane: the
 * setting leaves it there and a window or display exists. The engine then asks the app for a tab
 * (`namzu/browser/pane/*`); an app that does not name it is never asked, and the engine opens a
 * browser of its own.
 */
export const DESKTOP_BROWSER_PANE_CAPABILITY = 'namzu/browser-pane'

export function desktopInitializeParams(clientVersion?: string, added: readonly string[] = []) {
	return {
		protocolVersion: 1,
		capabilities: [...DESKTOP_CLIENT_CAPABILITIES, ...added],
		clientInfo: {
			name: DESKTOP_CLIENT_NAME,
			...(clientVersion ? { version: clientVersion } : {}),
		},
	}
}
