/**
 * Client for clawtool's BIAM peer registry (`/v1/peers`) — the canonical
 * cross-terminal / cross-host agent coordination layer. namzu registers
 * itself here as a peer so any orchestrator (clawtool's dashboard, another
 * namzu's `/agents`) can see it, and messages it via the same registry.
 *
 * namzu does NOT run its own session daemon for this — clawtool already owns
 * peer presence, heartbeats, messaging, broadcast, mDNS LAN discovery, and a
 * dashboard. We just register + list + send through it.
 *
 * Every call is best-effort: with no reachable clawtool daemon the helpers
 * return null / [] / false so the TUI works the same with or without it.
 */

import { type EnsureDaemonOptions, ensureDaemon } from './daemon.js'

export interface Peer {
	readonly peer_id: string
	readonly display_name: string
	readonly backend: string
	readonly circle?: string
	readonly role?: string
	readonly status?: string
	readonly session_id?: string
	readonly pid?: number
	readonly path?: string
	readonly last_seen?: string
}

export interface RegisterPeerInput {
	readonly display_name: string
	readonly backend: string
	readonly path?: string
	readonly session_id?: string
	readonly pid?: number
	readonly circle?: string
	readonly metadata?: Record<string, string>
}

async function endpoint(
	opts: EnsureDaemonOptions,
): Promise<{ baseUrl: string; token: string } | null> {
	try {
		return await ensureDaemon(opts)
	} catch {
		return null
	}
}

function authHeaders(token: string, withBody: boolean): Record<string, string> {
	const h: Record<string, string> = {}
	if (token.length > 0) h.Authorization = `Bearer ${token}`
	if (withBody) h['content-type'] = 'application/json'
	return h
}

/** Register (or refresh) this process as a BIAM peer; returns its peer_id. */
export async function registerPeer(
	input: RegisterPeerInput,
	opts: EnsureDaemonOptions = {},
): Promise<string | null> {
	const ep = await endpoint(opts)
	if (!ep) return null
	const fetchFn = opts.fetch ?? globalThis.fetch
	try {
		const res = await fetchFn(new URL('/v1/peers/register', ep.baseUrl).toString(), {
			method: 'POST',
			headers: authHeaders(ep.token, true),
			body: JSON.stringify(input),
		})
		if (!res.ok) return null
		const peer = (await res.json()) as Partial<Peer>
		return typeof peer.peer_id === 'string' ? peer.peer_id : null
	} catch {
		return null
	}
}

export async function heartbeatPeer(peerId: string, opts: EnsureDaemonOptions = {}): Promise<void> {
	const ep = await endpoint(opts)
	if (!ep) return
	const fetchFn = opts.fetch ?? globalThis.fetch
	try {
		await fetchFn(
			new URL(`/v1/peers/${encodeURIComponent(peerId)}/heartbeat`, ep.baseUrl).toString(),
			{
				method: 'POST',
				headers: authHeaders(ep.token, false),
			},
		)
	} catch {
		// best-effort
	}
}

export async function deregisterPeer(
	peerId: string,
	opts: EnsureDaemonOptions = {},
): Promise<void> {
	const ep = await endpoint(opts)
	if (!ep) return
	const fetchFn = opts.fetch ?? globalThis.fetch
	try {
		await fetchFn(new URL(`/v1/peers/${encodeURIComponent(peerId)}`, ep.baseUrl).toString(), {
			method: 'DELETE',
			headers: authHeaders(ep.token, false),
		})
	} catch {
		// best-effort
	}
}

export async function listPeers(opts: EnsureDaemonOptions = {}): Promise<readonly Peer[]> {
	const ep = await endpoint(opts)
	if (!ep) return []
	const fetchFn = opts.fetch ?? globalThis.fetch
	try {
		const res = await fetchFn(new URL('/v1/peers', ep.baseUrl).toString(), {
			method: 'GET',
			headers: authHeaders(ep.token, false),
		})
		if (!res.ok) return []
		const data = (await res.json()) as { peers?: Peer[] } | Peer[]
		const peers = Array.isArray(data) ? data : data.peers
		return Array.isArray(peers) ? peers : []
	} catch {
		return []
	}
}

/** A message in a peer's BIAM inbox (clawtool `a2a.Message`). */
export interface InboxMessage {
	readonly id: string
	readonly type?: string
	readonly from_peer: string
	readonly to_peer?: string
	readonly text: string
	readonly correlation_id?: string
	readonly timestamp?: string
}

/**
 * Drain this peer's inbox — returns + clears pending messages other agents
 * sent to us. namzu polls this so clawtool / another agent can talk TO it,
 * not just be listed. (`peek` leaves messages in place; default drains.)
 */
export async function drainInbox(
	peerId: string,
	opts: EnsureDaemonOptions & { peek?: boolean } = {},
): Promise<readonly InboxMessage[]> {
	const ep = await endpoint(opts)
	if (!ep) return []
	const fetchFn = opts.fetch ?? globalThis.fetch
	try {
		const url = new URL(`/v1/peers/${encodeURIComponent(peerId)}/messages`, ep.baseUrl)
		if (opts.peek) url.searchParams.set('peek', '1')
		const res = await fetchFn(url.toString(), {
			method: 'GET',
			headers: authHeaders(ep.token, false),
		})
		if (!res.ok) return []
		const data = (await res.json()) as { messages?: InboxMessage[] }
		return Array.isArray(data.messages) ? data.messages : []
	} catch {
		return []
	}
}

/**
 * Send a message to another peer's BIAM inbox. `from` is our own peer id so
 * the recipient knows who sent it (and can reply) — clawtool stamps it as the
 * message's `from_peer`.
 */
export async function sendPeerMessage(
	peerId: string,
	text: string,
	opts: EnsureDaemonOptions & { from?: string } = {},
): Promise<boolean> {
	const ep = await endpoint(opts)
	if (!ep) return false
	const fetchFn = opts.fetch ?? globalThis.fetch
	const body: Record<string, unknown> = { text }
	if (opts.from) body.from_peer = opts.from
	try {
		const res = await fetchFn(
			new URL(`/v1/peers/${encodeURIComponent(peerId)}/messages`, ep.baseUrl).toString(),
			{ method: 'POST', headers: authHeaders(ep.token, true), body: JSON.stringify(body) },
		)
		return res.ok
	} catch {
		return false
	}
}
