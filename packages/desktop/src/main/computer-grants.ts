import {
	type ComputerAppsView,
	WHOLE_SCREEN,
	appKey,
	appLabel,
} from '../shared/computer-protocol.js'
import type { PermissionView } from '../shared/protocol.js'

/** The tool the agent drives the computer with. */
export const COMPUTER_TOOL = 'computer_use'
/** The agent's question that an application needs the real keyboard and mouse for a moment. */
export const SCREEN_MOMENT_TOOL = 'screen_moment'
/** The agent's question whether it may click and type in the person's own browser window. */
export const BROWSER_WINDOW_TOOL = 'browser_window'

type Call = PermissionView['calls'][number]

/** What Desktop does with a request that holds computer actions. */
export type ComputerDecision =
	/** Every action is in an application this conversation allowed: answer yes without a card. */
	| { kind: 'allow' }
	/** Some application has not been allowed: ask once about it, not about each action. */
	| { kind: 'ask-app'; apps: string[]; browser?: true }
	/** Draw the ordinary card: the request holds something these grants do not cover. */
	| { kind: 'ask' }

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The applications one conversation may drive. A yes lasts for the conversation (it is held by the
 * conversation, so it ends with it) and the person can take it back. What the agent marks as
 * something it asks about every time, and an action that closes, deletes, sends or submits, are never
 * covered: they keep their own card.
 */
export class ComputerGrants {
	private readonly granted = new Map<string, string>()
	private readonly used = new Map<string, string>()
	/** Browsers the person allowed to be clicked and typed in, by the card that says so. */
	private readonly browsers = new Set<string>()

	/** `ownApps` names this application's own windows: the agent is never allowed to approve itself. */
	constructor(private readonly ownApps: () => readonly string[]) {}

	private own(app: string): boolean {
		const key = appKey(app)
		return this.ownApps().some((name) => appKey(name) === key)
	}

	/** The application an action works on, or the screen as a whole when the host could not tell. */
	private appsOf(call: Call): string[] {
		const listed = (call.computer?.apps ?? []).map((app) => app.trim()).filter(Boolean)
		if (listed.length > 0) return listed
		const app = call.computer?.app?.trim()
		return [app ? app : WHOLE_SCREEN]
	}

	decide(calls: readonly Call[]): ComputerDecision {
		if (calls.length === 0) return { kind: 'ask' }
		const missing = new Map<string, string>()
		// Browsers the engine itself will put its question about: asked once, in the browser's words.
		const missingBrowsers = new Map<string, string>()
		for (const call of calls) {
			if (call.name === SCREEN_MOMENT_TOOL) {
				const raw = record(call.input) ? call.input.app : undefined
				const app = typeof raw === 'string' && raw.trim() ? raw.trim() : WHOLE_SCREEN
				if (this.own(app) || !this.granted.has(appKey(app))) return { kind: 'ask' }
				continue
			}
			if (call.name !== COMPUTER_TOOL) return { kind: 'ask' }
			// The agent said to ask every time (the first look at the screen), or the action itself
			// closes, deletes, sends or submits: the person answers for that one.
			if (call.alwaysAsk === true || call.computer?.consequence) return { kind: 'ask' }
			// A batch can act in several applications; each needs its own yes.
			const browserAsk = new Set((call.computer?.browserAsk ?? []).map(appKey))
			for (const app of this.appsOf(call)) {
				// Namzu's own window is not an application it may be allowed into: a click there
				// could answer its own question.
				if (this.own(app)) return { kind: 'ask' }
				if (browserAsk.has(appKey(app))) {
					// An acting call the engine will ask about needs the browser's own yes; the plain
					// yes that a look was given does not cover clicking and typing.
					if (!this.browsers.has(appKey(app))) missingBrowsers.set(appKey(app), appLabel(app))
					continue
				}
				if (this.granted.has(appKey(app))) continue
				missing.set(appKey(app), appLabel(app))
			}
		}
		if (missing.size > 0) return { kind: 'ask-app', apps: [...missing.values()] }
		// One card per browser: the ordinary application card is not drawn for it as well.
		if (missingBrowsers.size > 0)
			return { kind: 'ask-app', apps: [...missingBrowsers.values()], browser: true }
		return { kind: 'allow' }
	}

	/**
	 * The person allowed these applications for the conversation. `browser` marks that the card they
	 * answered was the browser's (click and type in it), which also answers the engine's own
	 * browser question for it.
	 */
	grant(apps: readonly string[], options: { browser?: boolean } = {}): void {
		for (const app of apps) {
			this.granted.set(appKey(app), appLabel(app))
			this.used.set(appKey(app), appLabel(app))
			if (options.browser) this.browsers.add(appKey(app))
		}
	}

	/** Whether the person already said yes to clicking and typing in this browser. */
	browserAllowed(app: string): boolean {
		return this.browsers.has(appKey(app))
	}

	/** The person took an application back. Returns whether it was allowed. */
	revoke(app: string): boolean {
		this.browsers.delete(appKey(app))
		return this.granted.delete(appKey(app))
	}

	/** Work was done in this application, allowed or not. Returns whether it is new to the list. */
	markUsed(app: string): boolean {
		const key = appKey(app)
		if (this.used.has(key) || this.own(app)) return false
		this.used.set(key, appLabel(app))
		return true
	}

	has(app: string): boolean {
		return this.granted.has(appKey(app))
	}

	view(): ComputerAppsView {
		return { granted: [...this.granted.values()], used: [...this.used.values()] }
	}
}
