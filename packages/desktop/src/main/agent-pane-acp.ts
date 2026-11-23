import type { DesktopSettings } from '../shared/settings-protocol.js'
import { type AgentPaneRelay, RelayError, type RelayEvent } from './agent-pane-relay.js'

/**
 * The engine's browser host reaching the Browser pane (see `agent-pane-relay.ts`), over the
 * connection the app already has to the engine. This file is the wire: which requests the engine
 * may send, how each is answered, and how the relay's events are said back. It holds no page and no
 * debugger; every check that protects a page is in the relay, and nothing here widens one.
 *
 * Requests the engine sends, all `{ sessionId, ... }` where `sessionId` is the engine's own name for
 * a conversation (never a tab or a window; the app maps it to the conversation that owns it):
 *
 * - `namzu/browser/pane/open` `{ rules? }` answers `{ tabId, targetInfo }`.
 * - `namzu/browser/pane/cdp` `{ tabId, method, params?, cdpSessionId? }` answers `{ result }`.
 * - `namzu/browser/pane/close` `{ tabId?, release? }` answers `{}`; `release` detaches and keeps the tabs.
 *
 * Notifications the app sends: `namzu/browser/pane/event` (`kind` is `cdp`, `tab-added`,
 * `tab-closed` or `detached`) and `namzu/browser/pane/state` (`agent` or `person` holds the tab).
 * A refused or failed request is answered with an error whose message is plain words and whose
 * `data.code` is the relay's code.
 */

export const AGENT_PANE_CAPABILITY = 'namzu/browser-pane'

export const AGENT_PANE_REQUESTS = {
	open: 'namzu/browser/pane/open',
	cdp: 'namzu/browser/pane/cdp',
	close: 'namzu/browser/pane/close',
} as const

export const AGENT_PANE_NOTIFICATIONS = {
	event: 'namzu/browser/pane/event',
	state: 'namzu/browser/pane/state',
} as const

export function isAgentPaneRequest(method: unknown): boolean {
	return (
		typeof method === 'string' && (Object.values(AGENT_PANE_REQUESTS) as string[]).includes(method)
	)
}

/** What the relay offers the engine's connection; `AgentPaneRelay` is this. */
export type AgentPaneRelayLike = Pick<
	AgentPaneRelay,
	'open' | 'cdp' | 'close' | 'onEvent' | 'releaseConversation' | 'conversationEnded'
>

/**
 * Whether the app tells an engine it can host the agent's browser: the setting leaves it to the
 * pane, and there is a window to hold the tab or a display to make one on. The relay still fails an
 * open with no window, and the engine then opens its own browser.
 */
export function offersAgentPane(input: {
	setting: DesktopSettings['agentBrowser']
	windows: number
	display: boolean
}): boolean {
	return input.setting === 'pane' && (input.windows > 0 || input.display)
}

/** Whether this machine has a display to open a window on. Windows and macOS always do. */
export function hasDisplay(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
	return platform !== 'linux' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
}

export interface PaneAnswer {
	ok: true
	result: unknown
}
export interface PaneFailure {
	ok: false
	/** The JSON-RPC error code. */
	code: number
	message: string
	/** A stable word the engine can pick its own wording by. */
	reason: string
}

const INVALID_PARAMS = -32602
const REFUSED = -32000

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

const failure = (code: number, message: string, reason: string): PaneFailure => ({
	ok: false,
	code,
	message,
	reason,
})

/**
 * Serves one request of the engine for the conversation that owns its session. The conversation is
 * the app's, found by the caller from the engine's session id; nothing the engine sends can name a
 * different one. `allowed` is read at every request, so turning the setting off stops the next one.
 */
export async function serveAgentPane(
	relay: Pick<AgentPaneRelay, 'open' | 'cdp' | 'close' | 'releaseConversation'>,
	conversationId: string,
	method: string,
	rawParams: unknown,
	allowed: () => boolean,
): Promise<PaneAnswer | PaneFailure> {
	if (!allowed())
		return failure(REFUSED, 'Namzu is set to browse in a window of its own.', 'unavailable')
	const params = object(rawParams)
	if (!params) return failure(INVALID_PARAMS, 'The request has no parameters.', 'method-refused')
	try {
		switch (method) {
			case AGENT_PANE_REQUESTS.open: {
				const opened = await relay.open({
					conversationId,
					rules: params.rules,
				})
				return { ok: true, result: opened }
			}
			case AGENT_PANE_REQUESTS.cdp: {
				if (typeof params.tabId !== 'string' || typeof params.method !== 'string')
					return failure(INVALID_PARAMS, 'The call names no tab or method.', 'method-refused')
				const result = await relay.cdp({
					conversationId,
					tabId: params.tabId,
					method: params.method,
					...(params.params !== undefined ? { params: params.params } : {}),
					...(typeof params.cdpSessionId === 'string' ? { sessionId: params.cdpSessionId } : {}),
				})
				return { ok: true, result: { result: result ?? {} } }
			}
			case AGENT_PANE_REQUESTS.close: {
				if (params.tabId !== undefined && typeof params.tabId !== 'string')
					return failure(INVALID_PARAMS, 'The tab is not named as text.', 'method-refused')
				if (params.release === true && params.tabId === undefined) {
					// The engine lets go; the tabs stay for the person.
					relay.releaseConversation(conversationId, 'released-by-engine', false)
					return { ok: true, result: {} }
				}
				relay.close({
					conversationId,
					...(typeof params.tabId === 'string' ? { tabId: params.tabId } : {}),
				})
				return { ok: true, result: {} }
			}
			default:
				return failure(REFUSED, 'That request is not one the app answers.', 'method-refused')
		}
	} catch (error) {
		if (error instanceof RelayError) return failure(REFUSED, error.message, error.code)
		return failure(REFUSED, 'The Browser pane could not answer.', 'cdp-error')
	}
}

/** A relay event as the notification the engine is sent, for the engine's own session id. */
export function paneNotification(
	event: RelayEvent,
	sessionId: string,
): { method: string; params: Record<string, unknown> } | undefined {
	switch (event.kind) {
		case 'cdp':
			return {
				method: AGENT_PANE_NOTIFICATIONS.event,
				params: {
					sessionId,
					kind: 'cdp',
					tabId: event.tabId,
					method: event.method,
					params: event.params,
					...(event.sessionId ? { cdpSessionId: event.sessionId } : {}),
				},
			}
		case 'tab-added':
			return {
				method: AGENT_PANE_NOTIFICATIONS.event,
				params: {
					sessionId,
					kind: 'tab-added',
					tabId: event.tabId,
					...(event.openerTabId ? { openerTabId: event.openerTabId } : {}),
					targetInfo: event.targetInfo,
				},
			}
		case 'tab-closed':
			return {
				method: AGENT_PANE_NOTIFICATIONS.event,
				params: { sessionId, kind: 'tab-closed', tabId: event.tabId },
			}
		case 'detached':
			return {
				method: AGENT_PANE_NOTIFICATIONS.event,
				params: {
					sessionId,
					kind: 'detached',
					tabId: event.tabId,
					reason: event.reason,
				},
			}
		case 'state':
			return {
				method: AGENT_PANE_NOTIFICATIONS.state,
				params: { sessionId, tabId: event.tabId, state: event.state },
			}
	}
}
