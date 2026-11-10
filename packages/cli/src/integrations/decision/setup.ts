import { DecisionError } from '@namzu/decision'

import { setUserConfigValue } from '../../config/user-config.js'
import {
	type ConnectionOptions,
	type SavedConnection,
	connectionToBlock,
	saveDecisionKey,
	writeConnection,
} from './connection.js'
import { type DecisionBuildDeps, maybeCreateDecisionModel } from './model.js'

/** What the person gave the connect flow; the paste and the form steps fill it in. */
export interface SetupDraft {
	readonly kind: 'azure' | 'http'
	readonly endpoint?: string
	readonly key?: string
	readonly deployment?: string
	readonly url?: string
	readonly model?: string
}

export const CONNECTION_TEST_TIMEOUT_MS = 3000

export type ConnectionTestResult =
	| { readonly ok: true; readonly ms: number }
	| { readonly ok: false; readonly reason: string }

export interface TimeoutHandle {
	readonly signal: AbortSignal
	readonly clear: () => void
}

export interface ConnectionTestDeps extends DecisionBuildDeps {
	readonly now?: () => number
	/** An abort signal that fires after `ms`; the test seam for the 3 s deadline. */
	readonly startTimeout?: (ms: number) => TimeoutHandle
}

function realTimeout(ms: number): TimeoutHandle {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), ms)
	return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

/** The plain reason a decision call failed, in words that say what to look at. */
export function explainConnectionFailure(error: unknown, timedOut: boolean): string {
	if (timedOut) return `no answer within ${CONNECTION_TEST_TIMEOUT_MS / 1000} s`
	if (error instanceof DecisionError) {
		if (error.status === 401 || error.status === 403)
			return `the service refused the key (${error.status})`
		if (error.status === 404) return 'nothing answered at that address or deployment (404)'
		if (error.status !== undefined) return `the service answered ${error.status}: ${error.message}`
		return error.message
	}
	const message = error instanceof Error ? error.message : String(error)
	if (/no credential|empty|token|api.?key/i.test(message)) return `no credential: ${message}`
	return `could not reach it (${message})`
}

/** One cheap yes/no call with a 3 s deadline: "Connected" with its latency, or the reason. */
export async function testDecisionConnection(
	cfg: SavedConnection & { readonly points?: unknown },
	env: NodeJS.ProcessEnv,
	deps: ConnectionTestDeps = {},
): Promise<ConnectionTestResult> {
	const now = deps.now ?? Date.now
	const { points: _points, ...block } = cfg
	// The kill switch is for the running session, not for the person checking their own connection.
	const model = maybeCreateDecisionModel(
		block as SavedConnection,
		{ ...env, NAMZU_NO_DECISION: '' },
		deps,
	)
	if (!model) return { ok: false, reason: 'nothing is configured' }
	const timeout = (deps.startTimeout ?? realTimeout)(CONNECTION_TEST_TIMEOUT_MS)
	const started = now()
	try {
		await model.yesno('ok', 'Is this a connection test?', { signal: timeout.signal })
		return { ok: true, ms: Math.max(0, Math.round(now() - started)) }
	} catch (error) {
		return { ok: false, reason: explainConnectionFailure(error, timeout.signal.aborted) }
	} finally {
		timeout.clear()
	}
}

/** Deployment names the resource lists for this key, or none when it does not list them. */
export async function listAzureDeployments(
	endpoint: string,
	key: string,
	deps: {
		readonly fetch?: typeof fetch
		readonly startTimeout?: (ms: number) => TimeoutHandle
	} = {},
): Promise<string[]> {
	const timeout = (deps.startTimeout ?? realTimeout)(CONNECTION_TEST_TIMEOUT_MS)
	try {
		const res = await (deps.fetch ?? globalThis.fetch)(
			`${endpoint}/openai/deployments?api-version=2023-03-15-preview`,
			{ headers: { 'api-key': key }, signal: timeout.signal },
		)
		if (!res.ok) return []
		const body = (await res.json()) as { data?: unknown }
		if (!Array.isArray(body.data)) return []
		return body.data
			.map((item) => (item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined))
			.filter((id): id is string => typeof id === 'string' && id.length > 0)
	} catch {
		return []
	} finally {
		timeout.clear()
	}
}

export function draftToConnection(draft: SetupDraft): SavedConnection | undefined {
	if (draft.kind === 'azure') {
		return draft.endpoint && draft.deployment
			? { provider: 'azure', endpoint: draft.endpoint, deployment: draft.deployment }
			: undefined
	}
	return draft.url
		? { provider: 'http', url: draft.url, ...(draft.model ? { model: draft.model } : {}) }
		: undefined
}

export interface SaveOutcome {
	readonly connection: SavedConnection
	readonly configFile: string
}

/**
 * Save a connection: the key to the private credential store, the rest to the saved
 * connection and the user config's `decision` block (with the default points). A key
 * is never written to a config file.
 */
export function saveConnection(draft: SetupDraft, opts: ConnectionOptions = {}): SaveOutcome {
	const connection = draftToConnection(draft)
	if (!connection) throw new Error('The connection is missing its address.')
	if (draft.key) saveDecisionKey(draft.key, opts)
	writeConnection(connection, opts)
	const configFile = setUserConfigValue(['decision'], connectionToBlock(connection), {
		...(opts.home ? { home: opts.home } : {}),
		...(opts.env ? { env: opts.env } : {}),
	})
	return { connection, configFile }
}

export function connectedNotice(result: ConnectionTestResult): string {
	return result.ok ? `Connected · ${result.ms} ms` : `Saved, but not connected: ${result.reason}`
}
