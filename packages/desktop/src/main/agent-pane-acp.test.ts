import { expect, it, vi } from 'vitest'
import {
	AGENT_PANE_NOTIFICATIONS,
	AGENT_PANE_REQUESTS,
	hasDisplay,
	isAgentPaneRequest,
	offersAgentPane,
	paneNotification,
	serveAgentPane,
} from './agent-pane-acp.js'
import { RelayError } from './agent-pane-relay.js'

const relay = () => ({
	open: vi.fn(async () => ({ tabId: 't1', targetInfo: {} })),
	cdp: vi.fn(async () => undefined),
	close: vi.fn(),
})

it('offers the pane only when the setting leaves it there and a window or display exists', () => {
	expect(offersAgentPane({ setting: 'pane', windows: 1, display: false })).toBe(true)
	expect(offersAgentPane({ setting: 'pane', windows: 0, display: true })).toBe(true)
	expect(offersAgentPane({ setting: 'pane', windows: 0, display: false })).toBe(false)
	expect(offersAgentPane({ setting: 'window', windows: 2, display: true })).toBe(false)
	expect(hasDisplay('linux', {})).toBe(false)
	expect(hasDisplay('linux', { DISPLAY: ':0' })).toBe(true)
	expect(hasDisplay('win32', {})).toBe(true)
	expect(hasDisplay('darwin', {})).toBe(true)
})

it('knows the three requests of the engine and no other', () => {
	for (const name of Object.values(AGENT_PANE_REQUESTS)) expect(isAgentPaneRequest(name)).toBe(true)
	expect(isAgentPaneRequest(AGENT_PANE_NOTIFICATIONS.event)).toBe(false)
	expect(isAgentPaneRequest('session/request_permission')).toBe(false)
	expect(isAgentPaneRequest(undefined)).toBe(false)
})

it('serves a call for the conversation it was given, whatever else the request names', async () => {
	const r = relay()
	const answer = await serveAgentPane(
		r,
		'mine',
		AGENT_PANE_REQUESTS.cdp,
		{
			sessionId: 'engine-id',
			conversationId: 'theirs',
			tabId: 't1',
			method: 'Page.enable',
		},
		() => true,
	)
	expect(answer).toEqual({ ok: true, result: { result: {} } })
	expect(r.cdp).toHaveBeenCalledWith({
		conversationId: 'mine',
		tabId: 't1',
		method: 'Page.enable',
	})
})

it('passes the child session and parameters, and answers a bare close', async () => {
	const r = relay()
	await serveAgentPane(
		r,
		'mine',
		AGENT_PANE_REQUESTS.cdp,
		{
			tabId: 't1',
			method: 'Runtime.evaluate',
			params: { expression: '1' },
			cdpSessionId: 'c',
		},
		() => true,
	)
	expect(r.cdp).toHaveBeenCalledWith({
		conversationId: 'mine',
		tabId: 't1',
		method: 'Runtime.evaluate',
		params: { expression: '1' },
		sessionId: 'c',
	})
	expect(await serveAgentPane(r, 'mine', AGENT_PANE_REQUESTS.close, {}, () => true)).toEqual({
		ok: true,
		result: {},
	})
	expect(r.close).toHaveBeenCalledWith({ conversationId: 'mine' })
})

it('refuses what is not shaped as a request, an unknown request, and every request while the setting says window', async () => {
	const r = relay()
	const refuse = async (method: string, params: unknown, allowed = true) =>
		serveAgentPane(r, 'mine', method, params, () => allowed)
	expect(await refuse(AGENT_PANE_REQUESTS.cdp, undefined)).toMatchObject({
		ok: false,
		code: -32602,
	})
	expect(await refuse(AGENT_PANE_REQUESTS.cdp, { tabId: 1, method: 'x' })).toMatchObject({
		ok: false,
		reason: 'method-refused',
	})
	expect(await refuse(AGENT_PANE_REQUESTS.close, { tabId: 7 })).toMatchObject({
		ok: false,
	})
	expect(await refuse('namzu/browser/pane/other', {})).toMatchObject({
		ok: false,
	})
	expect(await refuse(AGENT_PANE_REQUESTS.open, {}, false)).toMatchObject({
		ok: false,
		reason: 'unavailable',
	})
	expect(r.open).not.toHaveBeenCalled()
	expect(r.cdp).not.toHaveBeenCalled()
	expect(r.close).not.toHaveBeenCalled()
})

it('answers a relay refusal with its words and code, and an unexpected failure with neither detail', async () => {
	const r = relay()
	r.cdp.mockRejectedValueOnce(new RelayError('method-refused', 'That call is not allowed.'))
	expect(
		await serveAgentPane(
			r,
			'mine',
			AGENT_PANE_REQUESTS.cdp,
			{ tabId: 't', method: 'A.b' },
			() => true,
		),
	).toEqual({
		ok: false,
		code: -32000,
		message: 'That call is not allowed.',
		reason: 'method-refused',
	})
	r.cdp.mockRejectedValueOnce(new Error('secret path /home/x'))
	const failed = await serveAgentPane(
		r,
		'mine',
		AGENT_PANE_REQUESTS.cdp,
		{ tabId: 't', method: 'A.b' },
		() => true,
	)
	expect(failed).toMatchObject({ ok: false, reason: 'cdp-error' })
	expect(JSON.stringify(failed)).not.toContain('secret')
})

it('says each relay event with the engine’s session id and nothing of the conversation’s', () => {
	expect(
		paneNotification(
			{
				kind: 'cdp',
				conversationId: 'c',
				tabId: 't',
				method: 'Page.x',
				params: { a: 1 },
				sessionId: 'k',
			},
			'engine',
		),
	).toEqual({
		method: AGENT_PANE_NOTIFICATIONS.event,
		params: {
			sessionId: 'engine',
			kind: 'cdp',
			tabId: 't',
			method: 'Page.x',
			params: { a: 1 },
			cdpSessionId: 'k',
		},
	})
	expect(
		paneNotification(
			{
				kind: 'tab-added',
				conversationId: 'c',
				tabId: 't2',
				openerTabId: 't',
				targetInfo: { u: 1 },
			},
			'engine',
		)?.params,
	).toEqual({
		sessionId: 'engine',
		kind: 'tab-added',
		tabId: 't2',
		openerTabId: 't',
		targetInfo: { u: 1 },
	})
	expect(
		paneNotification({ kind: 'tab-closed', conversationId: 'c', tabId: 't' }, 'engine')?.params,
	).toEqual({
		sessionId: 'engine',
		kind: 'tab-closed',
		tabId: 't',
	})
	expect(
		paneNotification(
			{ kind: 'detached', conversationId: 'c', tabId: 't', reason: 'closed' },
			'engine',
		)?.params,
	).toEqual({
		sessionId: 'engine',
		kind: 'detached',
		tabId: 't',
		reason: 'closed',
	})
	expect(
		paneNotification({ kind: 'state', conversationId: 'c', tabId: 't', state: 'person' }, 'engine'),
	).toEqual({
		method: AGENT_PANE_NOTIFICATIONS.state,
		params: { sessionId: 'engine', tabId: 't', state: 'person' },
	})
})
