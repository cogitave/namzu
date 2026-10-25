import { explainFailure } from './plain-failure.js'
/**
 * What the terminal says about the browser: the handoff notice when a page
 * needs the operator, the site-rule line on the review screen, and
 * `/browser`. Pure: App supplies the session's browser and prints the text.
 */

import type { ToolHandoff } from '@namzu/sdk'

import {
	type BrowserControl,
	type BrowserStatus,
	describeBrowserStatus,
} from '../browser/control.js'
import { browserCallOrigin, browserSiteRuleFor } from '../permissions/browser-sites.js'
import { terminalDisplayText } from './terminal-display.js'

function clean(value: string | undefined, max = 240): string {
	const flat = terminalDisplayText((value ?? '').replace(/\s+/g, ' ').trim())
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** What the operator does at the window, by the host's reason. */
const AT_THE_WINDOW: Record<string, string> = {
	'sign-in': 'sign in to',
	'two-factor': 'finish signing in to',
	captcha: 'complete the check on',
	'bot-block': 'get past the check on',
	'credential-field': 'type the password or code on',
}

/**
 * The notice for a turn the browser paused, or `undefined` for a handoff
 * from another tool. With a window, the operator does it there; without
 * one (headless), `namzu browser login` opens one.
 */
export function describeBrowserHandoff(
	handoff: ToolHandoff,
	browser: Pick<BrowserStatus, 'headless' | 'profile'> | undefined,
): string | undefined {
	const detail = handoff.detail ?? {}
	if (detail.tool !== 'browser') return undefined
	const origin = clean(detail.origin, 200) || 'the site'
	const profile = clean(detail.profile ?? browser?.profile, 64) || 'default'
	const what = clean(handoff.reason)
	const command = clean(detail.loginCommand, 400) || `namzu browser login ${profile} ${origin}`
	const lead = `Paused. The browser needs you: ${what}.`
	if (detail.cause === 'http-auth') {
		if (browser && !browser.headless) {
			return `${lead}\nCheck access to ${origin} in the browser window (profile ${profile}). If authentication succeeds, press Enter to continue, or Esc to stop.`
		}
		return `${lead}\nThis browser has no window, so Namzu closed it to free the profile. In another terminal run:\n  ${command}\nCheck access in the window it opens, then close it. If authentication succeeds, press Enter here to continue, or Esc to stop.`
	}
	if (browser && !browser.headless) {
		const verb = AT_THE_WINDOW[detail.cause ?? ''] ?? 'sign in to'
		return `${lead}\n${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${origin} in the browser window (profile ${profile}), then press Enter to continue, or Esc to stop.`
	}
	return `${lead}\nThis browser has no window, so Namzu closed it to free the profile. In another terminal run:\n  ${command}\nsign in in the window it opens, close it, then press Enter here to continue, or Esc to stop.`
}

/**
 * One line per browser call in a review, saying what the site rule decided in
 * words: `Browser: asks before using github.com (profile work).`
 */
export function browserSiteNotes(
	toolCalls: readonly { readonly name: string; readonly input: unknown }[],
	browser: Pick<BrowserStatus, 'sites' | 'profile'> | undefined,
): string[] {
	if (!browser) return []
	const notes: string[] = []
	for (const call of toolCalls) {
		const origin = browserCallOrigin(call.name, call.input)
		if (origin === undefined) continue
		const rule = browserSiteRuleFor(browser.sites, origin)
		const site = clean(origin.replace(/^https?:\/\//u, ''), 120)
		const what =
			rule.level === 'deny'
				? `${site} is blocked`
				: rule.level === 'read'
					? `${site} can be read but not changed`
					: rule.level === 'act'
						? `can use ${site} without asking`
						: `asks before using ${site}`
		const note = `Browser: ${what} (profile ${clean(browser.profile, 64)}).`
		if (!notes.includes(note)) notes.push(note)
	}
	return notes
}

export const BROWSER_SLASH_USAGE = [
	'/browser                 which browser, profile and site rules this conversation uses',
	'/browser profile <name>  use another profile from the next browser call on',
].join('\n')

/**
 * `/browser [status] | profile [<name>]`. Returns the text to print, and the
 * profile to remember when it switched one (so a rebuilt session keeps it).
 */
export async function runBrowserSlash(
	control: BrowserControl | undefined,
	args: readonly string[],
	options: { readonly busy: boolean },
): Promise<{ readonly text: string; readonly profile?: string }> {
	if (!control) {
		return {
			text: 'This conversation has no browser. It is on by default in the interactive terminal; check `browser.enabled` in your config and `namzu doctor` (browser.installed, browser.engine).',
		}
	}
	const [verb, name, ...rest] = args
	if (verb === undefined || (verb === 'status' && name === undefined)) {
		return { text: describeBrowserStatus(control.status()) }
	}
	if (verb === 'profile' && rest.length === 0) {
		if (name === undefined) {
			return {
				text: `Profile: ${control.status().profile}. Switch with /browser profile <name>; list profiles with \`namzu browser list\`.`,
			}
		}
		if (options.busy) {
			return {
				text: 'The profile cannot change while a reply is running. Try again when it ends.',
			}
		}
		try {
			const status = await control.switchProfile(name)
			return {
				text: `The browser uses profile ${status.profile} from the next browser call on, in this conversation. Sign in to a site once with \`namzu browser login ${status.profile} <url>\`.`,
				profile: status.profile,
			}
		} catch (error) {
			// A profile name Namzu refuses is explained in its own words ("… is not a profile name").
			return {
				text:
					error instanceof Error && error.message
						? error.message
						: explainFailure(error, 'Could not switch the browser profile.'),
			}
		}
	}
	return { text: `Usage:\n${BROWSER_SLASH_USAGE}` }
}
