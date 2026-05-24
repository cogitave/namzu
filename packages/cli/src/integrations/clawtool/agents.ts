/**
 * Client for clawtool's `GET /v1/agents` — the authoritative registry of
 * which AI-coding-agent instances clawtool can dispatch to on this host.
 *
 * Namzu does NOT reimplement credential detection, OAuth scanning, or
 * bridge wiring. Clawtool already owns all of that. The TUI just renders
 * what this endpoint returns.
 */

import { type EnsureDaemonOptions, ensureDaemon } from './daemon.js'

export interface Agent {
	readonly instance: string
	readonly family: string
	readonly bridge?: string
	/** `"callable" | "bridge-missing" | "binary-missing" | "disabled"` per clawtool's supervisor. */
	readonly status: string
	readonly callable: boolean
	readonly auth_scope?: string
	readonly tags?: readonly string[]
	readonly failover_to?: readonly string[]
	readonly sandbox?: string
}

export interface ListAgentsOptions extends EnsureDaemonOptions {
	/** When true, server-side filter to `status=callable`. */
	readonly callableOnly?: boolean
}

export interface AgentsResponse {
	readonly agents: readonly Agent[]
	readonly count: number
}

export async function listAgents(opts: ListAgentsOptions = {}): Promise<readonly Agent[]> {
	const endpoint = await ensureDaemon(opts)
	const fetchFn = opts.fetch ?? globalThis.fetch
	const url = new URL('/v1/agents', endpoint.baseUrl)
	if (opts.callableOnly) url.searchParams.set('status', 'callable')

	const headers: Record<string, string> = {}
	if (endpoint.token.length > 0) {
		headers.Authorization = `Bearer ${endpoint.token}`
	}

	const res = await fetchFn(url.toString(), { method: 'GET', headers })
	if (!res.ok) {
		throw new Error(`clawtool GET /v1/agents failed: HTTP ${res.status}`)
	}
	const data = (await res.json()) as Partial<AgentsResponse>
	if (!data || !Array.isArray(data.agents)) {
		throw new Error('clawtool /v1/agents returned an unexpected shape')
	}
	return data.agents
}
