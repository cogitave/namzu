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
	DiskMemoryStore,
	DiskTaskStore,
	type HITLResumeDecision,
	type LLMProvider,
	type Message,
	type ProjectId,
	ProviderRegistry,
	type ResumeHandler,
	type RunEvent,
	type RunId,
	SearchToolsTool,
	type SessionId,
	type TaskGateway,
	type TaskStore,
	type TenantId,
	type ThreadId,
	type ToolCallSummary,
	ToolRegistry,
	buildMemoryTools,
	getBuiltinTools,
	query,
} from '@namzu/sdk'

import { join } from 'node:path'
import { loadClawtoolToolDefinitions } from '../integrations/clawtool/tooling.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
	type ProviderId,
	discoverProviders,
	ensureFreshAnthropicToken,
	findDetected,
	isAnthropicOAuthToken,
	readClaudeCodeKeychainCredential,
	readPreferences,
} from '../integrations/providers/index.js'
import { createSubagentRuntime } from '../integrations/subagents/runtime.js'
import { composeMemoryPrompt, readMemory } from '../memory/store.js'

export type AgentEvent =
	| { readonly kind: 'delta'; readonly text: string }
	| {
			readonly kind: 'tool-start'
			/** SDK tool-use id — stable across this call's start/end (for tracking). */
			readonly toolUseId: string
			readonly toolName: string
			readonly summary: string
			/** Diff / content preview shown (collapsible) under the call. */
			readonly detail?: readonly string[]
	  }
	| {
			readonly kind: 'tool-end'
			readonly toolUseId: string
			readonly toolName: string
			readonly isError: boolean
			readonly summary: string
			/** Output lines shown (collapsible) under the result. */
			readonly detail?: readonly string[]
	  }
	| { readonly kind: 'usage'; readonly totalTokens: number; readonly costUsd: number }
	| { readonly kind: 'task'; readonly subject: string; readonly status: string }
	| { readonly kind: 'done'; readonly finishReason?: string }
	| { readonly kind: 'error'; readonly message: string }

/** A single tool the model wants to run, surfaced to the user for approval. */
export interface PermissionToolCall {
	readonly id: string
	readonly name: string
	readonly summary: string
	readonly isDestructive: boolean
	/** Optional multi-line preview (e.g. content to write, edit diff). */
	readonly preview?: readonly string[]
}

export interface PermissionRequest {
	readonly toolCalls: readonly PermissionToolCall[]
}

export type PermissionDecision =
	| { readonly kind: 'approve' }
	| { readonly kind: 'approve-all' }
	| { readonly kind: 'reject'; readonly feedback?: string }

export type PermissionFn = (req: PermissionRequest) => Promise<PermissionDecision>

export interface SendOptions {
	readonly signal?: AbortSignal
	/**
	 * Called before a batch of non-read-only tools runs. Resolves with the
	 * user's decision. When omitted, every tool batch is auto-approved
	 * (non-interactive behavior).
	 */
	readonly onPermission?: PermissionFn
	/**
	 * Extra system context to inject for this turn (e.g. active skills),
	 * merged after the persistent memory block.
	 */
	readonly extraSystem?: string
}

export interface AgentSession {
	readonly hasProvider: boolean
	readonly providerSummary: string | null
	readonly modelSummary: string | null
	readonly toolNames: readonly string[]
	/** Count of clawtool tools registered deferred (loadable via search_tools). */
	readonly deferredToolCount: number
	readonly errorHint: string | null
	send(messages: readonly Message[], opts?: SendOptions): AsyncIterable<AgentEvent>
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

// Builtins we don't expose: `append` (write/edit cover it) and
// `verify_outputs` — neither is part of the recognizable Claude-Code tool
// surface, and showing them just adds noise to `/tools`.
const EXCLUDED_BUILTINS = new Set(['append', 'verify_outputs'])

// namzu's own identity. Injected as system context so the agent presents as
// namzu — not Claude/Claude Code — even on the Anthropic OAuth path, which
// requires a "You are Claude Code" prefix block for the token to authorize.
const NAMZU_IDENTITY = [
	"You are namzu, an AI coding agent that runs in the user's terminal via the namzu CLI.",
	'You are built on the @namzu/sdk and act through tools (bash, read, write, edit, glob, grep).',
	'Your name is namzu. When asked who or what you are, identify yourself as namzu —',
	'not Claude or Claude Code — even though you may be powered by an underlying model',
	'from Anthropic or another provider.',
	'',
	'CRITICAL — never fabricate. Only claim to have done something if you actually did it through a tool call in THIS turn:',
	'- Never say you ran a command, wrote/edited a file, delegated to a sub-agent, or researched something unless the corresponding tool call actually ran and returned.',
	'- Never invent file paths, command output, URLs, research findings, or results. If you announce an action ("running…", "delegating…"), you MUST immediately make the tool call — do not narrate an action and then skip it.',
	'- If a capability or tool is unavailable (e.g. no web access, a tool is missing, a sub-agent failed), say so plainly and stop — do not improvise a fake result.',
	'- When you delegate with the `Agent` tool, report only what the sub-agent actually returned in its tool result; if it wrote files, verify with a tool before claiming paths.',
].join('\n')

function buildToolRegistry(): ToolRegistry {
	const registry = new ToolRegistry()
	registry.register(getBuiltinTools().filter((t) => !EXCLUDED_BUILTINS.has(t.name)))
	// SDK memory: the agent gets search_memory / read_memory / save_memory over
	// a structured store at ~/.namzu/memory (separate from the user-curated
	// MEMORY.md that's injected into the prompt).
	const memoryStore = new DiskMemoryStore({ baseDir: join(process.cwd(), '.namzu') })
	registry.register(buildMemoryTools(memoryStore, memoryStore.getIndex()))
	// `search_tools` lets the model load deferred (clawtool) tools on demand.
	registry.register([SearchToolsTool])
	return registry
}

export async function createAgentSession(
	prefs: Preferences,
	detected: readonly DetectedProvider[],
	scope: RunScope = mintScope(),
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
	// Claude Code OAuth access tokens are short-lived (~8h). They rarely lapse
	// *during* a turn, but they do between turns — an idle session that sends
	// again hours later would otherwise 401. So before each turn (see `send`)
	// we re-read the Keychain (Claude Code may have rotated it) and refresh a
	// stale token, rebuilding the client only when the token actually changed.
	// Gated on `det.oauth` so env / secrets credentials are never touched.
	const keychainRefresh = prefs.provider === 'anthropic' && Boolean(det?.oauth)
	let currentToken = det?.apiKey
	const refreshTokenIfNeeded = async (): Promise<void> => {
		if (!keychainRefresh) return
		const cred = readClaudeCodeKeychainCredential()
		if (!cred) return
		const fresh = await ensureFreshAnthropicToken(cred.accessToken, {
			refreshToken: cred.refreshToken,
			expiresAt: cred.expiresAt,
		})
		if (fresh === currentToken) return
		currentToken = fresh
		try {
			provider = constructProvider(
				'anthropic',
				{ ...(det as DetectedProvider), apiKey: fresh },
				model,
			)
		} catch {
			// Keep the previous client; the turn may still 401 but won't crash.
		}
	}
	const registry = buildToolRegistry()
	// clawtool's catalog (~70 tools) is registered DEFERRED: each costs only a
	// name line in the prompt (no JSON schema), so it never balloons a turn —
	// the model loads what it needs via `search_tools`. Best-effort: absent /
	// down / slow clawtool just yields zero deferred tools, non-fatal.
	const clawtoolTools = await loadClawtoolToolDefinitions({ skipNames: registry.listNames() })
	if (clawtoolTools.length > 0) registry.register(clawtoolTools, 'deferred')
	// Native sub-agents: register the canonical `Agent` tool so the model can
	// delegate a self-contained task to a fresh sub-agent (own context window).
	// Best-effort — if the runtime can't stand up, the chat still works.
	let subagentGateway: TaskGateway | undefined
	// Buffer of the in-flight sub-agent's tool steps. The gateway streams the
	// child's events here while the parent's `Agent` tool call blocks; runTurn
	// drains it onto the `Agent` result as a `├─/└─` tree. Scoped per `Agent`
	// call (cleared when one starts).
	const childSteps: string[] = []
	try {
		const sub = await createSubagentRuntime({
			cwd: process.cwd(),
			model,
			buildProvider: () =>
				constructProvider(
					prefs.provider,
					det ? { ...det, apiKey: currentToken ?? det.apiKey } : det,
					model,
				),
			buildTools: () => {
				// Sub-agents get the same working set as the parent — builtins +
				// memory + search_tools, plus clawtool's catalog (deferred) so they
				// can load research / peer-dispatch tools on demand. Without this a
				// sub-agent has no way to do real work beyond local files.
				const r = buildToolRegistry()
				if (clawtoolTools.length > 0) r.register(clawtoolTools, 'deferred')
				return r
			},
			verificationGate: VERIFICATION_GATE,
			onEvent: (e) => {
				if (e.type === 'tool_executing') {
					childSteps.push(`${e.toolName}(${summarizeToolInput(e.input)})`)
				}
			},
		})
		registry.register([sub.agentTool])
		subagentGateway = sub.gateway
	} catch {
		// Sub-agents unavailable this session — non-fatal.
	}
	const activeToolNames = registry.getCallableTools().map((t) => t.name)
	const deferredToolCount = clawtoolTools.length
	// Task store → query auto-registers create_task / update_task / list_tasks
	// and emits task_created/task_updated, so the agent can track a plan for the
	// current request (Claude-Code todo style). Tasks are run-scoped.
	const taskStore: TaskStore = new DiskTaskStore({
		baseDir: join(process.cwd(), '.namzu'),
		defaultRunId: 'run_namzu-cli' as RunId,
		tenantId: scope.tenantId,
	})
	// Persists across turns: once the user picks "approve all", later tool
	// batches in this session run without prompting.
	const approval = { all: false }
	return {
		hasProvider: true,
		providerSummary: entry.label,
		modelSummary: model,
		toolNames: activeToolNames,
		deferredToolCount,
		errorHint: null,
		send: async function* (messages, opts) {
			// Renew a lapsed OAuth token before the turn runs (no-op for valid
			// tokens and non-keychain credentials).
			await refreshTokenIfNeeded()
			// namzu identity first (so it establishes who the agent is even when
			// the Anthropic OAuth path prepends the required Claude Code prefix),
			// then memory read fresh each turn, then per-turn extra (active skills).
			const memoryPrompt = composeMemoryPrompt(readMemory())
			const systemPrompt =
				[NAMZU_IDENTITY, memoryPrompt, opts?.extraSystem]
					.filter((s): s is string => Boolean(s))
					.join('\n\n') || undefined
			yield* runTurn(
				provider,
				model,
				registry,
				scope,
				approval,
				taskStore,
				systemPrompt,
				messages,
				opts,
				subagentGateway,
				childSteps,
			)
		},
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

export interface RunScope {
	sessionId: SessionId
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

// Pre-execution safety gate: hard-deny catastrophic shell patterns
// (`rm -rf /`, mkfs, `curl … | sh`, sudo, fork bombs — the SDK's narrow
// DANGEROUS_PATTERNS list, which does NOT match e.g. `rm -rf node_modules`),
// auto-allow read-only tools, and send everything else to the permission
// prompt (`review` → our resumeHandler). The deny rule applies even in
// --yolo mode, so bypass never lets the model brick the machine.
const VERIFICATION_GATE = {
	enabled: true,
	allowReadOnlyTools: true,
	denyDangerousPatterns: true,
	logDecisions: false,
	rules: [],
}

// Automatic context compression for long, tool-heavy turns: the structured
// strategy summarizes old tool results / notes once the message buffer
// crosses the trigger threshold of the token budget, keeping the most
// recent messages verbatim. A no-op for short turns; a safety net against
// unbounded context growth on long ones.
const COMPACTION_CONFIG = {
	strategy: 'structured' as const,
	triggerThreshold: 0.7,
	resetThreshold: 0.4,
	keepRecentMessages: 6,
	maxToolResults: 30,
	maxListSize: 25,
	llmVerification: false,
	llmVerificationMaxTokens: 2048,
	richStateThreshold: 15,
	convoTextBudget: 12_000,
	maxSentencesPerTurn: 5,
	maxCharsPerNote: 500,
	maxCharsPerRequirement: 300,
	maxCharsPerTask: 400,
}

async function* runTurn(
	provider: LLMProvider,
	model: string,
	tools: ToolRegistry,
	scope: RunScope,
	approval: { all: boolean },
	taskStore: TaskStore,
	systemPrompt: string | undefined,
	messages: readonly Message[],
	opts: SendOptions | undefined,
	taskGateway: TaskGateway | undefined,
	childSteps: string[],
): AsyncIterable<AgentEvent> {
	const signal = opts?.signal
	try {
		const events = query({
			provider,
			tools,
			taskStore,
			...(taskGateway ? { taskGateway } : {}),
			verificationGate: VERIFICATION_GATE,
			compactionConfig: COMPACTION_CONFIG,
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
			...(systemPrompt ? { systemPrompt } : {}),
			messages: [...messages],
			workingDirectory: process.cwd(),
			resumeHandler: makeResumeHandler(approval, opts?.onPermission),
			signal,
			...scope,
		})
		for await (const event of events) {
			if (signal?.aborted) {
				yield { kind: 'error', message: 'aborted' }
				return
			}
			const mapped = toAgentEvent(event)
			if (!mapped) continue
			// On an `Agent` delegation finishing, attach the sub-agent's tool
			// steps (collected via the gateway while the call blocked) as a
			// `├─/└─` tree under its result, then reset for the next delegation.
			// (Don't clear on tool_executing: the parent's events can be buffered
			// and pulled only after the child already ran, which would wipe it.)
			if (
				event.type === 'tool_completed' &&
				event.toolName === 'Agent' &&
				childSteps.length > 0 &&
				mapped.kind === 'tool-end'
			) {
				yield { ...mapped, detail: [...(mapped.detail ?? []), ...asTree(childSteps)] }
				childSteps.length = 0
				continue
			}
			yield mapped
		}
	} catch (err) {
		yield {
			kind: 'error',
			message: err instanceof Error ? err.message : String(err),
		}
	}
}

/**
 * Bridge the SDK's HITL `tool_review` request to the TUI's permission
 * callback. Read-only batches (nothing destructive) run silently; batches
 * with a destructive call prompt the user unless they've already chosen
 * "approve all" for the session. Plans and iteration checkpoints are
 * auto-continued (the TUI doesn't use plan mode).
 */
export function makeResumeHandler(
	approval: { all: boolean },
	onPermission: PermissionFn | undefined,
): ResumeHandler {
	return async (request): Promise<HITLResumeDecision> => {
		if (request.type !== 'tool_review') {
			return request.type === 'plan_approval' ? { action: 'approve_plan' } : { action: 'continue' }
		}
		if (!onPermission || approval.all || !batchNeedsPrompt(request.toolCalls)) {
			return { action: 'approve_tools' }
		}
		const decision = await onPermission({
			toolCalls: request.toolCalls.map((tc) => ({
				id: tc.id,
				name: tc.name,
				summary: summarizeToolInput(tc.input),
				isDestructive: tc.isDestructive,
				preview: previewToolInput(tc.name, tc.input),
			})),
		})
		switch (decision.kind) {
			case 'approve':
				return { action: 'approve_tools' }
			case 'approve-all':
				approval.all = true
				return { action: 'approve_tools' }
			case 'reject':
				return {
					action: 'reject_tools',
					feedback: decision.feedback ?? 'User declined to run the proposed tool(s).',
				}
		}
	}
}

/**
 * Tools known to only observe, never mutate. Anything NOT in this set
 * prompts for approval (safe-by-default: unknown and future tools — e.g.
 * bridged clawtool tools — are treated as needing consent). Matched
 * case-insensitively so `Read`/`read` both count.
 */
const READ_ONLY_TOOLS = new Set([
	'read',
	'glob',
	'grep',
	'ls',
	'verify_outputs',
	// Memory + task tools touch only the agent's own ~/.namzu state — safe, no prompt.
	'search_memory',
	'read_memory',
	'save_memory',
	'task_create',
	'task_update',
	'task_list',
])

/**
 * A batch needs explicit approval when any call mutates state: flagged
 * destructive by the SDK, or simply not on the read-only allowlist.
 */
export function batchNeedsPrompt(toolCalls: readonly ToolCallSummary[]): boolean {
	return toolCalls.some((tc) => tc.isDestructive || !READ_ONLY_TOOLS.has(tc.name.toLowerCase()))
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
				toolUseId: event.toolUseId,
				toolName: event.toolName,
				summary: summarizeToolInput(event.input),
				detail: toolStartDetail(event.toolName, event.input),
			}
		case 'tool_completed':
			return {
				kind: 'tool-end',
				toolUseId: event.toolUseId,
				toolName: event.toolName,
				isError: event.isError,
				summary: firstLine(event.result),
				detail: toolEndDetail(event.toolName, event.result),
			}
		case 'token_usage_updated':
			return {
				kind: 'usage',
				totalTokens: event.usage.totalTokens,
				costUsd: event.cost.totalCost,
			}
		case 'task_created':
			return { kind: 'task', subject: event.subject, status: event.status }
		case 'task_updated':
			// Only surface completions — skip pending/in-progress churn so the
			// transcript shows "todo added" then "todo done", not every flip.
			return event.status === 'completed'
				? { kind: 'task', subject: event.subject, status: event.status }
				: null
		case 'run_completed':
			return { kind: 'done' }
		case 'run_failed':
			return { kind: 'error', message: event.error }
		default:
			return null
	}
}

/** Render a sub-agent's tool steps as a `├─/└─` tree for the Agent result. */
function asTree(steps: readonly string[]): string[] {
	return steps.map((s, i) => `${i === steps.length - 1 ? '└─' : '├─'} ${s}`)
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

/**
 * Multi-line preview of a mutating tool's effect, shown in the permission
 * overlay so the user approves with sight of what changes. `write` shows
 * the leading content lines; `edit` shows a minimal -old / +new diff;
 * everything else has no preview (the one-line summary suffices). Pure —
 * unit-tested.
 */
export function previewToolInput(toolName: string, input: unknown): readonly string[] | undefined {
	if (!input || typeof input !== 'object') return undefined
	const obj = input as Record<string, unknown>
	const str = (k: string) => (typeof obj[k] === 'string' ? (obj[k] as string) : undefined)
	const name = toolName.toLowerCase()
	if (name === 'write') {
		const content = str('content')
		if (content !== undefined) return previewLines(content, 8)
	}
	if (name === 'edit') {
		const oldStr = str('old_string') ?? str('oldStr')
		const newStr = str('new_string') ?? str('newStr')
		const lines: string[] = []
		if (oldStr) for (const l of previewLines(oldStr, 4)) lines.push(`- ${l}`)
		if (newStr) for (const l of previewLines(newStr, 4)) lines.push(`+ ${l}`)
		if (lines.length > 0) return lines
	}
	return undefined
}

function previewLines(value: string, max: number): string[] {
	const lines = value.split('\n')
	const head = lines.slice(0, max).map((l) => truncate(l, 100))
	if (lines.length > max) head.push(`… (+${lines.length - max} more lines)`)
	return head
}

const MAX_DETAIL_LINES = 200

function clampLines(value: string): string[] {
	const lines = value.replace(/\s+$/, '').split('\n')
	return lines.length > MAX_DETAIL_LINES ? lines.slice(0, MAX_DETAIL_LINES) : lines
}

/**
 * Diff / content shown under a tool CALL (`⏺`): an `edit` renders a
 * `- old` / `+ new` diff, a `write` renders the content. Other tools show
 * nothing at call time (their output appears under the result instead).
 */
export function toolStartDetail(toolName: string, input: unknown): readonly string[] | undefined {
	if (!input || typeof input !== 'object') return undefined
	const obj = input as Record<string, unknown>
	const str = (k: string) => (typeof obj[k] === 'string' ? (obj[k] as string) : undefined)
	const name = toolName.toLowerCase().replace(/^clawtool_/, '')
	if (name === 'write') {
		const content = str('content')
		return content !== undefined ? clampLines(content) : undefined
	}
	if (name === 'edit') {
		const oldStr = str('old_string') ?? str('oldStr')
		const newStr = str('new_string') ?? str('newStr')
		const lines: string[] = []
		if (oldStr) for (const l of clampLines(oldStr)) lines.push(`- ${l}`)
		if (newStr) for (const l of clampLines(newStr)) lines.push(`+ ${l}`)
		return lines.length > 0 ? lines : undefined
	}
	return undefined
}

/** Parse a string as a JSON object, or null. clawtool/MCP tools return JSON. */
function parseJsonObject(s: string): Record<string, unknown> | null {
	const t = s.trim()
	if (!(t.startsWith('{') || t.startsWith('['))) return null
	try {
		const v = JSON.parse(t)
		return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
	} catch {
		return null
	}
}

/** Pretty-print JSON tool output; otherwise return the raw text as lines. */
function resultToLines(result: string): string[] {
	const obj = parseJsonObject(result)
	if (obj) {
		// Many tools wrap their payload in {output|result|content|text}: show
		// that inline rather than the JSON envelope, which reads far cleaner.
		const inner = obj.output ?? obj.result ?? obj.content ?? obj.text
		if (typeof inner === 'string' && inner.trim().length > 0) return clampLines(inner.trim())
		return clampLines(JSON.stringify(obj, null, 2))
	}
	return clampLines(result.trim())
}

/**
 * Output shown under a tool RESULT (`⎿`). For `edit`/`write` the diff was
 * already shown at call time, so the result stays a one-line confirmation;
 * every other tool (read/bash/grep/…) shows its captured output here — JSON
 * results are pretty-printed / unwrapped so they don't read as a raw blob.
 */
export function toolEndDetail(toolName: string, result: string): readonly string[] | undefined {
	const name = toolName.toLowerCase().replace(/^clawtool_/, '')
	if (name === 'edit' || name === 'write') return undefined
	if (result.trim().length === 0) return undefined
	const lines = resultToLines(result)
	// A single short line is already the summary — no need to repeat it.
	return lines.length <= 1 ? undefined : lines
}

/** Concise one-line summary of a tool result for the `⎿` line. */
function firstLine(result: string): string {
	const obj = parseJsonObject(result)
	if (obj) {
		const inner = obj.output ?? obj.result ?? obj.message ?? obj.text
		if (typeof inner === 'string' && inner.trim().length > 0) {
			return truncate(inner.trim().split('\n')[0] ?? '', 120)
		}
		if (obj.success === false && typeof obj.error === 'string') return truncate(obj.error, 120)
		// Bare object with no obvious payload: summarize by its keys.
		const keys = Object.keys(obj)
		return keys.length > 0
			? `{ ${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', …' : ''} }`
			: '{}'
	}
	const trimmed = result.trim()
	const nl = trimmed.indexOf('\n')
	return truncate(nl === -1 ? trimmed : trimmed.slice(0, nl), 120)
}

function emptySession(errorHint: string): AgentSession {
	return {
		hasProvider: false,
		providerSummary: null,
		modelSummary: null,
		toolNames: [],
		deferredToolCount: 0,
		errorHint,
		send: async function* () {
			yield { kind: 'error' as const, message: errorHint }
		},
	}
}
