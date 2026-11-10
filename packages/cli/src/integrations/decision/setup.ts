import { DecisionError } from '@namzu/decision'

import { setUserConfigValue } from '../../config/user-config.js'
import {
	type ConnectionOptions,
	type SavedConnection,
	clearDecisionKey,
	connectionToBlock,
	saveDecisionKey,
	writeConnection,
} from './connection.js'
import { type DecisionBuildDeps, maybeCreateDecisionModel } from './model.js'
import { OPENROUTER_DECISION_URL, sanitizeServiceText } from './openrouter.js'

/** What the person gave the connect flow; the paste and the form steps fill it in. */
export interface SetupDraft {
	readonly kind: 'azure' | 'http' | 'openrouter'
	readonly endpoint?: string
	readonly key?: string
	readonly deployment?: string
	readonly url?: string
	readonly model?: string
	/** A variable that already holds the key (OpenRouter); the key is then not saved at all. */
	readonly keyEnv?: string
}

export const CONNECTION_TEST_TIMEOUT_MS = 3000

export type ConnectionTestResult =
	| {
			readonly ok: true
			readonly ms: number
			/** What the test cost in USD, when the service said. */
			readonly costUsd?: number
	  }
	| {
			readonly ok: false
			readonly reason: string
			/** The model answered 400 to Namzu's questions: pick another, do not fall back. */
			readonly unsupportedModel?: true
	  }

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

/** A 400 that says the model wants another question shape (missing or null instructions or criteria). */
export function isQuestionShapeError(error: unknown): boolean {
	return (
		error instanceof DecisionError &&
		error.status === 400 &&
		/(missing|null|required).*(instructions|criteria)|(instructions|criteria).*(missing|null|required)/i.test(
			error.message,
		)
	)
}

/** The plain reason a decision call failed, in words that say what to look at. */
export function explainConnectionFailure(error: unknown, timedOut: boolean): string {
	const said = (e: DecisionError) => sanitizeServiceText(e.message, 200)
	if (timedOut) return `no answer within ${CONNECTION_TEST_TIMEOUT_MS / 1000} s`
	if (error instanceof DecisionError) {
		if (error.status === 401 || error.status === 403)
			return `the service refused the key (${error.status})`
		if (isQuestionShapeError(error))
			return `the model does not work with Namzu's questions (${said(error)})`
		if (error.status === 404) return 'nothing answered at that address or deployment (404)'
		if (error.status !== undefined) return `the service answered ${error.status}: ${said(error)}`
		return said(error)
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
	// The cost rides in the body (`usage.cost`); the driver does not surface it, so it is read off a copy.
	const cost: { usd?: number } = {}
	const baseFetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init))
	const model = maybeCreateDecisionModel(
		block as SavedConnection,
		{ ...env, NAMZU_NO_DECISION: '' },
		{
			...deps,
			fetch: async (input, init) => {
				const res = await baseFetch(input, init)
				try {
					const body = (await res.clone().json()) as { usage?: { cost?: unknown } }
					if (typeof body.usage?.cost === 'number') cost.usd = body.usage.cost
				} catch {
					// No cost to show.
				}
				return res
			},
		},
	)
	if (!model) return { ok: false, reason: 'nothing is configured' }
	const timeout = (deps.startTimeout ?? realTimeout)(CONNECTION_TEST_TIMEOUT_MS)
	const started = now()
	try {
		await model.yesno('ok', 'Is this a connection test?', {
			signal: timeout.signal,
			criteria: 'Yes when the text is a short plain word.',
		})
		return {
			ok: true,
			ms: Math.max(0, Math.round(now() - started)),
			...(cost.usd !== undefined ? { costUsd: cost.usd } : {}),
		}
	} catch (error) {
		return {
			ok: false,
			reason: explainConnectionFailure(error, timeout.signal.aborted),
			...(!timeout.signal.aborted && isQuestionShapeError(error)
				? { unsupportedModel: true as const }
				: {}),
		}
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
	if (draft.kind === 'openrouter') {
		return draft.model
			? {
					provider: 'http',
					url: OPENROUTER_DECISION_URL,
					model: draft.model,
					...(draft.keyEnv ? { apiKeyEnv: draft.keyEnv } : {}),
				}
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
	// No key typed means no key: one saved for an earlier connection must not carry over to this one.
	if (draft.key) saveDecisionKey(draft.key, opts)
	else clearDecisionKey(opts)
	writeConnection(connection, opts)
	const configFile = setUserConfigValue(['decision'], connectionToBlock(connection), {
		...(opts.home ? { home: opts.home } : {}),
		...(opts.env ? { env: opts.env } : {}),
	})
	return { connection, configFile }
}

export function connectedNotice(result: ConnectionTestResult): string {
	return result.ok
		? `Connected · ${result.ms} ms${result.costUsd === undefined ? '' : ` · test cost ${formatCost(result.costUsd)}`}`
		: `Saved, but not connected: ${result.reason}`
}

/** A USD amount for a fraction-of-a-cent call: `$0.0000021`, or `no charge`. */
export function formatCost(usd: number): string {
	if (usd <= 0) return 'no charge'
	return `$${usd.toFixed(Math.min(10, Math.max(4, 1 - Math.floor(Math.log10(usd)))))}`
}
