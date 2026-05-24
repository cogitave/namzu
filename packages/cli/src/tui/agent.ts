/**
 * TUI agent session — provider-direct, tool-enabled.
 *
 * Reads the picker selection (preferences.json), looks up the chosen
 * provider in the declarative registry, lazy-loads the matching
 * `@namzu/<type>` package, constructs the SDK provider, builds a
 * `ToolRegistry` of the SDK builtin tools (bash / read / write / edit /
 * glob / grep / …), and exposes `send(messages, signal?) →
 * AsyncIterable<AgentEvent>` over the SDK agent loop `query()`.
 *
 * Unlike the earlier `chatStream()`-only adapter, this drives the full
 * tool-execution loop: the model can call tools, their results are fed
 * back, and the loop iterates until the turn settles. We translate the
 * SDK's `RunEvent` stream into the TUI's smaller `AgentEvent` vocabulary
 * (text deltas + tool start/end + done/error).
 *
 * The TUI owns conversation history and passes the full `Message[]` on
 * every turn (stateless session). Empty / partial states (no
 * credentials, no preferences, no matching detected provider) return an
 * `emptySession()` whose `send()` yields a single error event so the UI
 * renders an actionable hint rather than crashing.
 */

import {
	type LLMProvider,
	type Message,
	type ProjectId,
	ProviderRegistry,
	type RunEvent,
	type SessionId,
	type TenantId,
	type ThreadId,
	ToolRegistry,
	autoApproveHandler,
	getBuiltinTools,
	query,
} from '@namzu/sdk'

import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
	type ProviderId,
	discoverProviders,
	findDetected,
	isAnthropicOAuthToken,
	readPreferences,
} from '../integrations/providers/index.js'

export type AgentEvent =
	| { readonly kind: 'delta'; readonly text: string }
	| { readonly kind: 'tool-start'; readonly toolName: string; readonly summary: string }
	| {
			readonly kind: 'tool-end'
			readonly toolName: string
			readonly isError: boolean
			readonly summary: string
	  }
	| { readonly kind: 'done'; readonly finishReason?: string }
	| { readonly kind: 'error'; readonly message: string }

export interface AgentSession {
	readonly hasProvider: boolean
	readonly providerSummary: string | null
	readonly modelSummary: string | null
	readonly toolNames: readonly string[]
	readonly errorHint: string | null
	send(messages: readonly Message[], signal?: AbortSignal): AsyncIterable<AgentEvent>
}

export interface AgentSessionContext {
	readonly preferences: Preferences | null
	readonly needsRepickReason: string | null
	readonly detected: readonly DetectedProvider[]
}

/**
 * Read preferences + run discovery once. Returned context drives the
 * App's lifecycle decision: ready / picker / unhealthy.
 */
export async function probeAgentSession(): Promise<AgentSessionContext> {
	const read = readPreferences()
	const detected = await discoverProviders()
	switch (read.status) {
		case 'ok':
			return { preferences: read.prefs, needsRepickReason: null, detected }
		case 'missing':
			return { preferences: null, needsRepickReason: null, detected }
		case 'needs-repick':
			return { preferences: null, needsRepickReason: read.reason, detected }
	}
}

const registered = new Set<ProviderId>()

async function ensureRegistered(id: ProviderId): Promise<void> {
	if (registered.has(id)) return
	switch (id) {
		case 'anthropic': {
			const mod = await import('@namzu/anthropic')
			mod.registerAnthropic()
			break
		}
		case 'openai': {
			const mod = await import('@namzu/openai')
			mod.registerOpenAI()
			break
		}
		case 'openrouter': {
			const mod = await import('@namzu/openrouter')
			mod.registerOpenRouter()
			break
		}
		case 'ollama': {
			const mod = await import('@namzu/ollama')
			mod.registerOllama()
			break
		}
		default:
			throw new Error(`provider "${id}" is not wired yet; pick another or wait for support`)
	}
	registered.add(id)
}

function buildToolRegistry(): ToolRegistry {
	const registry = new ToolRegistry()
	registry.register(getBuiltinTools())
	return registry
}

export async function createAgentSession(
	prefs: Preferences,
	detected: readonly DetectedProvider[],
): Promise<AgentSession> {
	const entry = PROVIDER_REGISTRY[prefs.provider]
	if (!entry) {
		return emptySession(`Unknown provider "${prefs.provider}" — pick another.`)
	}
	const det = findDetected(detected, prefs.provider)
	if (entry.requiresApiKey && (!det || !det.apiKey)) {
		return emptySession(
			`No credential found for ${entry.label}. Set one of: ${entry.envVars.join(', ')} — or pick another provider.`,
		)
	}
	try {
		await ensureRegistered(prefs.provider)
	} catch (err) {
		return emptySession(err instanceof Error ? err.message : String(err))
	}
	const model = prefs.model ?? entry.defaultModel
	let provider: LLMProvider
	try {
		provider = constructProvider(prefs.provider, det, model)
	} catch (err) {
		return emptySession(
			`Failed to construct ${entry.label}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	const registry = buildToolRegistry()
	const scope = mintScope()
	return {
		hasProvider: true,
		providerSummary: entry.label,
		modelSummary: model,
		toolNames: registry.listNames(),
		errorHint: null,
		send: (messages, signal) => runTurn(provider, model, registry, scope, messages, signal),
	}
}

function constructProvider(
	id: ProviderId,
	det: DetectedProvider | null,
	model: string,
): LLMProvider {
	switch (id) {
		case 'anthropic': {
			const token = det?.apiKey ?? ''
			const isOAuth = token.length > 0 && isAnthropicOAuthToken(token)
			const { provider } = ProviderRegistry.create({
				type: 'anthropic',
				...(isOAuth ? { authToken: token } : { apiKey: token }),
				baseURL: det?.baseUrl,
				model,
			})
			return provider
		}
		case 'openai': {
			const { provider } = ProviderRegistry.create({
				type: 'openai',
				apiKey: det?.apiKey ?? '',
				baseURL: det?.baseUrl,
				model,
			})
			return provider
		}
		case 'openrouter': {
			const { provider } = ProviderRegistry.create({
				type: 'openrouter',
				apiKey: det?.apiKey ?? '',
				baseUrl: det?.baseUrl,
			})
			return provider
		}
		case 'ollama': {
			const { provider } = ProviderRegistry.create({
				type: 'ollama',
				host: det?.baseUrl,
				model,
			})
			return provider
		}
		default:
			throw new Error(`provider "${id}" is not yet wired to ProviderRegistry`)
	}
}

interface RunScope {
	readonly sessionId: SessionId
	readonly threadId: ThreadId
	readonly projectId: ProjectId
	readonly tenantId: TenantId
}

/** One scope per launched TUI session; runId is minted fresh per turn by the SDK. */
function mintScope(): RunScope {
	const suffix = `tui-${Date.now().toString(36)}`
	return {
		sessionId: `ses_${suffix}`,
		threadId: `thd_${suffix}`,
		projectId: `prj_${suffix}`,
		tenantId: `tnt_${suffix}`,
	}
}

async function* runTurn(
	provider: LLMProvider,
	model: string,
	tools: ToolRegistry,
	scope: RunScope,
	messages: readonly Message[],
	signal: AbortSignal | undefined,
): AsyncIterable<AgentEvent> {
	try {
		const events = query({
			provider,
			tools,
			runConfig: {
				model,
				timeoutMs: 600_000,
				tokenBudget: 1_000_000,
				maxIterations: 50,
				maxResponseTokens: 8192,
				permissionMode: 'auto',
			},
			agentId: 'namzu',
			agentName: 'namzu',
			messages: [...messages],
			workingDirectory: process.cwd(),
			resumeHandler: autoApproveHandler,
			signal,
			...scope,
		})
		for await (const event of events) {
			if (signal?.aborted) {
				yield { kind: 'error', message: 'aborted' }
				return
			}
			const mapped = toAgentEvent(event)
			if (mapped) yield mapped
		}
	} catch (err) {
		yield { kind: 'error', message: err instanceof Error ? err.message : String(err) }
	}
}

/**
 * Translate one SDK `RunEvent` into the TUI's `AgentEvent` vocabulary, or
 * `null` for events the chat surface doesn't render (iteration markers,
 * token usage, checkpoints, plan/task lifecycle, …). Pure — unit-tested.
 */
export function toAgentEvent(event: RunEvent): AgentEvent | null {
	switch (event.type) {
		case 'text_delta':
			return { kind: 'delta', text: event.text }
		case 'tool_executing':
			return {
				kind: 'tool-start',
				toolName: event.toolName,
				summary: summarizeToolInput(event.input),
			}
		case 'tool_completed':
			return {
				kind: 'tool-end',
				toolName: event.toolName,
				isError: event.isError,
				summary: truncate(event.result.trim(), 200),
			}
		case 'run_completed':
			return { kind: 'done' }
		case 'run_failed':
			return { kind: 'error', message: event.error }
		default:
			return null
	}
}

/** Short, human-readable one-liner for a tool call (e.g. `ls -la`, path). */
function summarizeToolInput(input: unknown): string {
	if (input && typeof input === 'object') {
		const obj = input as Record<string, unknown>
		const pick = (k: string) => (typeof obj[k] === 'string' ? (obj[k] as string) : undefined)
		const primary =
			pick('command') ?? pick('path') ?? pick('file_path') ?? pick('pattern') ?? pick('query')
		if (primary) return truncate(primary, 120)
	}
	if (typeof input === 'string') return truncate(input, 120)
	return truncate(JSON.stringify(input ?? {}), 120)
}

function truncate(value: string, max: number): string {
	const oneLine = value.replace(/\s+/g, ' ')
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function emptySession(errorHint: string): AgentSession {
	return {
		hasProvider: false,
		providerSummary: null,
		modelSummary: null,
		toolNames: [],
		errorHint,
		send: async function* () {
			yield { kind: 'error' as const, message: errorHint }
		},
	}
}
