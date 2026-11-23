import type { DesktopTurnHandoff } from '../shared/protocol.js'

/** What the card says. Plain words: no tool name, no id, no jargon. */
export interface HandoffCard {
	title: string
	/** The thing to do, then what to press. */
	body: string
	/** Said apart from the body when the browser has no window to do it in. */
	fallback?: { lead: string; command: string }
}

/** What the person does at the page, by the reason the browser gave. */
const WHAT_TO_DO: Record<string, string> = {
	'sign-in': 'Sign in to',
	'two-factor': 'Finish signing in to',
	captcha: 'Complete the check on',
	'bot-block': 'Get past the check on',
	'http-auth': 'Allow access to',
	'credential-field': 'Type the password or code on',
}

/** The site as a person says it: no scheme, no path. */
export function siteName(origin: string | undefined): string | undefined {
	if (!origin) return undefined
	const bare = origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '')
	return bare || undefined
}

/**
 * What a paused turn needs, in words. A sign-in is "Sign in to <site> in the browser window, then
 * continue." When the browser has no window the way in is a command in a terminal; when it is not
 * known whether it has one (a conversation opened again), the card says what to do if no window shows.
 */
export function describeHandoff(handoff: DesktopTurnHandoff): HandoffCard {
	const site = siteName(handoff.origin)
	const verb = handoff.cause ? WHAT_TO_DO[handoff.cause] : undefined
	const isBrowser = handoff.tool === 'browser'
	const title = 'Namzu is waiting for you'
	if (!isBrowser || !verb || !site) {
		// Any other tool, or a reason this card has no sentence for: the tool's own words.
		const reason = handoff.reason.replace(/[.\s]+$/, '')
		return { title, body: `${reason}. When that is done, choose Continue.` }
	}
	const task = `${verb} ${site}`
	if (handoff.window === 'pane') {
		// The page is a tab of the Browser pane: nothing to open, and never a terminal command.
		return { title, body: `${task} in the Browser pane, then choose Continue.` }
	}
	const command = handoff.loginCommand
	if (handoff.window === 'none') {
		return {
			title,
			body: `${task}. Namzu’s browser has no window of its own here, so open one yourself, then choose Continue.`,
			...(command
				? {
						fallback: {
							lead: 'In a terminal, run this, do it in the window it opens, then close the window:',
							command,
						},
					}
				: {}),
		}
	}
	return {
		title,
		body: `${task} in the browser window Namzu opened, then choose Continue.`,
		...(handoff.window === undefined && command
			? {
					fallback: {
						lead: 'No window on screen? In a terminal, run this and do it in the window it opens:',
						command,
					},
				}
			: {}),
	}
}
