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
	type ProviderChainMember,
	ProviderRegistry,
	type ResumeHandler,
	type RunEvent,
	type RunId,
	SearchToolsTool,
	type SessionId,
	type StopReason,
	type TaskGateway,
	type TaskStore,
	type TenantId,
	type ThreadId,
	type ToolCallSummary,
	ToolRegistry,
	type VerificationRule,
	buildMemoryTools,
	getBuiltinTools,
	query,
} from '@namzu/sdk'

import { join } from 'node:path'
import { composeEnvironmentPrompt, readEnvironmentFacts } from '../context/environment.js'
import { loadProjectInstructions } from '../context/project.js'
import {
	type ConnectedMcpServer,
	type FailedMcpServer,
	type McpServersConfig,
	connectMcpServers,
} from '../integrations/mcp/servers.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
	type ProviderChoice,
	type ProviderId,
	chainCapabilityDisagreements,
	chainPositionName,
	describeAcceptedMismatch,
	describeCapabilityRefusal,
	discoverProviders,
	ensureFreshAnthropicToken,
	ensureRegistered,
	findDetected,
	isAnthropicOAuthToken,
	isRegistered,
	primaryProvider,
	readAgentKeychainCredential,
	readPreferences,
	resolveChainCapabilities,
	unresolvedMembers,
	unsupportedProviderMessage,
} from '../integrations/providers/index.js'
import { createSubagentRuntime } from '../integrations/subagents/runtime.js'
import { composeMemoryPrompt, readMemory } from '../memory/store.js'
import type { PermissionMode } from '../permissions/mode.js'

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
	| {
			readonly kind: 'usage'
			/** CUMULATIVE run spend. Grows every turn; never a context size. */
			readonly totalTokens: number
			readonly costUsd: number
			/**
			 * How full the context is NOW, and how full it may get.
			 *
			 * Separate from `totalTokens` because they answer different
			 * questions and one was long used to answer the other's: the gauge
			 * divided cumulative spend by a guessed window, so it climbed with
			 * turn count and read FULL on a conversation with room to spare.
			 * Spend is monotone by design, context is not.
			 *
			 * Carried with their provenance, and the two travel together. A
			 * ratio is only as sound as the weaker of its terms, so a surface
			 * cannot mark an estimated numerator honestly while silently
			 * treating an assumed window as measured.
			 *
			 * All four absent when the run resolved no window — then there is
			 * no proportion to show, only the spend.
			 */
			readonly contextTokens?: number
			readonly contextMeasuredBy?: 'provider' | 'estimate'
			readonly contextWindowTokens?: number
			readonly windowSource?: 'config' | 'model-table' | 'default'
	  }
	/**
	 * Context was discarded, or an attempt to discard it declined.
	 *
	 * Everything else this session fixed was the run quietly not doing what the
	 * operator asked. This is the same class with the opposite sign: the run
	 * quietly doing something they did not ask for. Compaction deletes messages
	 * irrecoverably, and the first time a user learned it existed was when the
	 * agent had forgotten something they were relying on — which reads as the
	 * model being stupid rather than the harness dropping context.
	 */
	| {
			readonly kind: 'context'
			readonly text: string
			/** False when the compaction declined and the history is unchanged. */
			readonly shed: boolean
	  }
	/**
	 * A member of the provider chain could not serve; a later one is now.
	 *
	 * Its own kind rather than a line folded into `context`, because the two
	 * answer different questions and only one of them is about the conversation.
	 * And it is an event at all — rather than a log line — for the reason this
	 * whole feature is careful: a turn that quietly ran on a provider the
	 * operator did not choose has succeeded while not doing what they asked,
	 * which is the defect class this package keeps removing.
	 */
	| { readonly kind: 'provider-fallback'; readonly text: string }
	| { readonly kind: 'task'; readonly subject: string; readonly status: string }
	/**
	 * The turn ended without throwing — which is not the same as succeeding.
	 *
	 * `stopReason` replaces a `finishReason?: string` that had no producer and
	 * no reader anywhere in this package. The name was also wrong for what is
	 * needed here: a "finish reason" in this codebase is `MessageStopReason`,
	 * reported per model message, while the question a caller has at the end of
	 * a turn is the run-level `StopReason` — did it answer, or did it run out
	 * of budget, iterations, time, or permission to say what it produced.
	 */
	| { readonly kind: 'done'; readonly stopReason?: StopReason }
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
	readonly errorHint: string | null
	/**
	 * Absolute paths of the `AGENTS.md` files whose text is in this session's
	 * system prompt — outermost first, exactly the set that was injected.
	 *
	 * Reported so a surface can tell the user which project instructions are in
	 * force. A user who cannot see this has no way to distinguish "namzu read my
	 * conventions and disagreed" from "namzu never saw them", and those call for
	 * opposite responses.
	 */
	readonly instructionFiles: readonly string[]
	/**
	 * Instruction files that are PRESENT and were not loaded, with the reason.
	 *
	 * An empty `instructionFiles` cannot distinguish "this project declares
	 * none" from "yours is a symlink out of the tree and namzu refused it", and
	 * those call for opposite responses. Refusing is right; refusing quietly is
	 * the failure this whole package keeps finding.
	 */
	readonly skippedInstructionFiles: readonly { readonly path: string; readonly reason: string }[]
	/** External tool servers that connected, and how many tools each brought. */
	readonly mcpConnected: readonly ConnectedMcpServer[]
	/**
	 * External tool servers that were configured and are NOT here, with why.
	 *
	 * The hazard this feature carries is an operator who declares a server,
	 * watches the agent run without its tools and concludes the model is bad at
	 * the task. An empty tool list is not a signal; a named failure is.
	 */
	readonly mcpFailed: readonly FailedMcpServer[]
	/**
	 * Delegates this session can dispatch to. Empty when the subagent runtime
	 * did not come up, which is non-fatal and leaves the session doing its own
	 * work.
	 *
	 * Reported because the roster was decided here and then discarded, so no
	 * surface could answer "what can this thing delegate to" without rebuilding
	 * the runtime to find out.
	 */
	readonly agentIds: readonly string[]
	/**
	 * Things about this session's configuration the operator must be told, every
	 * launch — today, an accepted capability disagreement in the provider chain,
	 * and any member whose declaration could not be read.
	 *
	 * Every launch rather than once, because that is what the acceptance is worth
	 * checking against: an operator who set the flag months ago and forgot has a
	 * chain that will quietly do less than they think, which is precisely the
	 * outcome the refusal exists to prevent. A notice shown once is a notice not
	 * shown.
	 */
	readonly configNotices: readonly string[]
	/**
	 * Whether "approve all" has been chosen at a prompt during this session.
	 *
	 * A FUNCTION, not a boolean, and that is the whole point of it. The latch
	 * lives in a mutable object the permission handler closes over, and it flips
	 * mid-turn on a single keystroke. A surface handed a boolean would be handed
	 * whatever the value was when the surface was built — and `/permissions` is
	 * rendered from a context object assembled on an earlier render, so a
	 * snapshot would reintroduce the staleness one layer up from where it was
	 * fixed.
	 *
	 * It exists because `/permissions` reported the approval posture from the
	 * operator's flags alone and could not see this, so it kept printing "you
	 * are asked before they run" after the operator had turned that off.
	 */
	readonly approvalLatched: () => boolean
	/**
	 * Tools this session will run without asking, by name.
	 *
	 * A function for the same reason as `approvalLatched`, plus one of its own:
	 * the roster is not final when the session is built. Task tools register
	 * deferred inside the first `query()`, so anything captured earlier would
	 * report a set the operator never had.
	 */
	readonly promptExemptTools: () => readonly string[]
	send(messages: readonly Message[], opts?: SendOptions): AsyncIterable<AgentEvent>
	/**
	 * Release what the session holds — today, the external tool servers.
	 *
	 * A stdio server is a CHILD PROCESS, and nothing else in this package owned
	 * one, which is why a session had no shutdown path at all. Idempotent, and
	 * safe to call on a session that connected nothing.
	 */
	close(): Promise<void>
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

// Builtins we don't expose: `verify_outputs` — a host-side check rather
// than something the model should be choosing to call, so in `/tools` it is
// noise. (`append` was removed from the SDK entirely; `edit` with
// insertLine:"end" covers it.)
const EXCLUDED_BUILTINS = new Set(['verify_outputs'])

// namzu's own identity. Injected as system context so the agent presents as
// namzu, and nothing else, whatever identity the credential path needs
// on the wire. Some OAuth token types require a fixed prefix block before
// they will authorize; that requirement lives in the credential layer and
// is invisible from here, which is where it belongs — an identity a token
// demands is not an identity the agent has.
const NAMZU_IDENTITY = [
	"You are namzu, an AI coding agent that runs in the user's terminal via the namzu CLI.",
	'You are built on the @namzu/sdk and act through tools (bash, read, write, edit, glob, grep).',
	'Your name is namzu. When asked who or what you are, identify yourself as namzu.',
	'You may be powered by an underlying model from any provider; that model is an',
	'implementation detail of how you run, not who you are. Never present yourself as',
	'the model, as the assistant product that model ships under, or as any other agent.',
	'',
	'CRITICAL — never fabricate. Only claim to have done something if you actually did it through a tool call in THIS turn:',
	'- Never say you ran a command, wrote/edited a file, delegated to a sub-agent, or researched something unless the corresponding tool call actually ran and returned.',
	'- Never invent file paths, command output, URLs, research findings, or results. If you announce an action ("running…", "delegating…"), you MUST immediately make the tool call — do not narrate an action and then skip it.',
	'- If a capability or tool is unavailable (e.g. no web access, a tool is missing, a sub-agent failed), say so plainly and stop — do not improvise a fake result.',
	'- When you delegate with the `Agent` tool, report only what the sub-agent actually returned in its tool result; if it wrote files, verify with a tool before claiming paths.',
	'- A reply from a tool that delegates to ANOTHER agent (a connector that runs another agent, an A2A `tasks/send`, a remote peer) is that agent\'s unverified CLAIM, not fact — another model can hallucinate. If it says it ran a command, wrote a file, or "here is the output", treat that as narrative and confirm it yourself with a deterministic tool (a real shell like `bash.run`, a file read) before reporting it as done. Distinguish such conversational agent calls from deterministic tools, and never present another agent\'s prose as your own verified result.',
].join('\n')

function buildToolRegistry(cwd: string): ToolRegistry {
	const registry = new ToolRegistry()
	registry.register(getBuiltinTools().filter((t) => !EXCLUDED_BUILTINS.has(t.name)))
	// SDK memory: the agent gets search_memory / read_memory / save_memory over
	// a structured store at `<cwd>/.namzu/memory` — the WORKING DIRECTORY, not
	// the home directory. Two comments here used to say `~/.namzu`, which made
	// `save_memory` look like it touched only namzu's own state and was part of
	// why it sat on the no-prompt list; it writes into the user's project.
	// Separate from the user-curated MEMORY.md that is injected into the prompt.
	const memoryStore = new DiskMemoryStore({ baseDir: join(cwd, '.namzu') })
	registry.register(buildMemoryTools(memoryStore, memoryStore.getIndex()))
	// `search_tools` is deliberately NOT registered here. It is only useful
	// where deferred tools exist, and that differs between this function's two
	// callers: the session below passes a `taskStore`, so query() registers the
	// task tools deferred and the search has a roster; a sub-agent is built with
	// no task store, so its registry has nothing deferred and the tool could
	// only ever answer "no deferred tools matching X" — a capability advertised
	// every turn that costs a turn to discover is unusable. Mounting it is the
	// caller's decision, made where the roster is known.
	return registry
}

export interface AgentSessionOptions {
	/** Session/thread/project/tenant identity for this run. Minted when absent. */
	readonly scope?: RunScope
	/**
	 * The directory the agent works in: what every filesystem tool resolves a
	 * relative path against, where sub-agents run, and where the task and
	 * memory stores put `.namzu`. Defaults to the process's own directory.
	 *
	 * Taken as an argument rather than read from `process.cwd()` at each of
	 * those four points, which is what let `--cwd` reach the session store and
	 * the skill search and stop there: the caller parsed a directory, the agent
	 * globbed a different one, and the run reported finding nothing rather than
	 * having looked in the wrong place.
	 */
	readonly cwd?: string
	/**
	 * Operator-authored tool rules, already compiled to the kernel's vocabulary.
	 *
	 * Absent means an empty rule list, which is what the CLI passed for the
	 * gate's whole existence: every mutating call fell through to the prompt.
	 * That stays the behaviour for anyone who writes no config.
	 */
	readonly rules?: readonly VerificationRule[]
	/** How calls no rule decided are resolved. Defaults to prompt/auto by TTY. */
	readonly permissionMode?: PermissionMode
	/**
	 * External tool servers to connect for this session, from the operator's
	 * config. Absent means none, which is what it meant before they existed.
	 */
	readonly mcpServers?: McpServersConfig
}

export async function createAgentSession(
	prefs: Preferences,
	detected: readonly DetectedProvider[],
	options: AgentSessionOptions = {},
): Promise<AgentSession> {
	const scope = options.scope ?? mintScope()
	const cwd = options.cwd ?? process.cwd()
	// The head serves; the tail is fallen over to, in order, when it cannot.
	const primary = primaryProvider(prefs)
	const entry = PROVIDER_REGISTRY[primary.id]
	if (!entry) {
		return emptySession(`Unknown provider "${primary.id}" — pick another.`)
	}
	const det = findDetected(detected, primary.id)
	if (entry.requiresApiKey && (!det || !det.apiKey)) {
		return emptySession(
			`No credential found for ${entry.label}. Set one of: ${entry.envVars.join(', ')} — or pick another provider.`,
		)
	}
	try {
		await ensureRegistered(primary.id)
	} catch (err) {
		return emptySession(err instanceof Error ? err.message : String(err))
	}

	// Does the chain agree with itself about what it can do? Asked before the
	// session exists, because the answer decides whether there should be one.
	const resolvedCapabilities = await resolveChainCapabilities(prefs.providers)
	const disagreements = chainCapabilityDisagreements(prefs.providers, resolvedCapabilities)
	if (disagreements.length > 0 && prefs.allowCapabilityMismatch !== true) {
		const refusal = describeCapabilityRefusal(disagreements)
		if (refusal) return emptySession(refusal)
	}
	const capabilityNotice = disagreements.length > 0 ? describeAcceptedMismatch(disagreements) : null
	// Not folded into the refusal: a member whose declaration could not be read
	// is not a disagreement, and reporting it as one would refuse a chain over a
	// question that was never answered.
	const unresolvedNotice = unresolvedMembers(prefs.providers, resolvedCapabilities)

	// Which fallbacks could actually serve, decided ONCE, at launch.
	//
	// A member with no credential is dropped here rather than left in the chain
	// to 401 on the day the primary goes down. Both would "work" — a 401 falls
	// over to the next member — but one of them tells the operator on a calm
	// Tuesday and the other tells them mid-incident, in the voice of a
	// credential rejection for a provider they never configured.
	const fallbackPlan = planFallbacks(prefs.providers, detected)

	const model = primary.model ?? entry.defaultModel
	let provider: LLMProvider
	try {
		provider = constructProvider(primary.id, det, model)
	} catch (err) {
		return emptySession(
			`Failed to construct ${entry.label}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	// OAuth access tokens on this path are short-lived (~8h). They rarely lapse
	// *during* a turn, but they do between turns — an idle session that sends
	// again hours later would otherwise 401. So before each turn (see `send`)
	// we re-read the keychain (another process may have rotated it) and refresh a
	// stale token, rebuilding the client only when the token actually changed.
	// Gated on `det.oauth` so env / secrets credentials are never touched.
	const keychainRefresh = primary.id === 'anthropic' && Boolean(det?.oauth)
	let currentToken = det?.apiKey
	const refreshTokenIfNeeded = async (): Promise<void> => {
		if (!keychainRefresh) return
		const cred = readAgentKeychainCredential()
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
	// Read ONCE, here, rather than per turn the way memory is.
	//
	// Memory is re-read every turn because `/remember` writes to it mid-session,
	// so a stale read would drop a fact the user just saved. Nothing in namzu
	// writes an instructions file, and reading once buys a property worth more
	// than the freshness: `instructionFiles` is then exactly the set whose text
	// went into the prompt, for the whole life of the session. Re-reading per
	// turn would make the line a surface prints at connect time a claim about
	// the past. An edited file takes effect on the next session.
	const projectInstructions = loadProjectInstructions(cwd)
	const registry = buildToolRegistry(cwd)
	// External tool servers, before the roster is counted, so `toolNames` and
	// the `/tools` list a user reads include what they configured. Connecting
	// after the count would report a session smaller than the one that runs.
	const mcp = await connectMcpServers(options.mcpServers, { cwd })
	if (mcp.tools.length > 0) registry.register([...mcp.tools])
	// This session passes a `taskStore` to query() below, which registers the
	// task tools deferred — so `search_tools` has something to find here.
	registry.register([SearchToolsTool])
	// Native sub-agents: register the canonical `Agent` tool so the model can
	// delegate a self-contained task to a fresh sub-agent (own context window).
	// Best-effort — if the runtime can't stand up, the chat still works.
	let subagentGateway: TaskGateway | undefined
	// Buffer of the in-flight sub-agent's tool steps. The gateway streams the
	// child's events here while the parent's `Agent` tool call blocks; runTurn
	// drains it onto the `Agent` result as a `├─/└─` tree. Scoped per `Agent`
	// call (cleared when one starts).
	const childSteps: string[] = []
	// Stays empty when the runtime below throws, which is the honest answer: the
	// catch is non-fatal and the session then genuinely has no delegate to
	// dispatch to. A roster reported from the request rather than the result
	// would name agents that are not there.
	let allowedAgentIds: readonly string[] = []
	try {
		const sub = await createSubagentRuntime({
			cwd,
			model,
			// A sub-agent works in the same repository and writes the same code,
			// so it is bound by the same instructions. Without this the parent
			// honours the project's rules and every task it delegates quietly
			// does not — the worse half of the feature, because the delegating
			// turn reports success either way.
			...(projectInstructions.prompt ? { projectInstructions: projectInstructions.prompt } : {}),
			// Same argument as the instructions, one step further: a sub-agent that
			// does not know what day it is dates a changelog entry from a training
			// cut-off, and the parent reports the delegation as successful.
			readEnvironment: async () => composeEnvironmentPrompt(await readEnvironmentFacts(cwd)),
			// A sub-agent resolves its provider INDEPENDENTLY: the primary, and no
			// chain. It does not inherit the parent's fallback list and it does not
			// inherit a swap the parent has already made.
			//
			// A decision, not an omission, and the reason is that a delegation is
			// not the parent's turn. The parent's chain is scoped to the parent's
			// turn (see `withProviderFallback`), and a sub-agent runs its own `query`
			// with its own lifetime — so "inheriting" would mean either handing over
			// a cursor whose scope no longer applies, or giving the child a second,
			// independently-advancing chain the operator was never told about. The
			// child announcing a swap the parent never made, inside a tool result,
			// is a worse surface than the child simply failing and the parent
			// reporting it.
			buildProvider: () =>
				constructProvider(
					primary.id,
					det ? { ...det, apiKey: currentToken ?? det.apiKey } : det,
					model,
				),
			buildTools: () => {
				// Sub-agents get the parent's working set minus `search_tools`:
				// they run without a task store, so nothing in their registry is
				// deferred and there is nothing for a search to load.
				return buildToolRegistry(cwd)
			},
			verificationGate: gateFor(options.rules),
			onEvent: (e) => {
				if (e.type === 'tool_executing') {
					childSteps.push(`${e.toolName}(${summarizeToolInput(e.input)})`)
				}
			},
		})
		registry.register([sub.agentTool])
		subagentGateway = sub.gateway
		allowedAgentIds = sub.allowedAgentIds
	} catch {
		// Sub-agents unavailable this session — non-fatal.
	}
	const activeToolNames = registry.getCallableTools().map((t) => t.name)
	// Task store → query registers task_create / task_update / task_list as
	// DEFERRED tools and emits task_created/task_updated, so the agent can track
	// a plan for the current request. Tasks are run-scoped.
	//
	// "Deferred" is why this session mounts `search_tools` above: these three are
	// the roster it searches. They are registered inside query(), after this
	// function returns, which is why the connect line reports no count of them —
	// counting here would mean restating query's registration order in the CLI.
	const taskStore: TaskStore = new DiskTaskStore({
		baseDir: join(cwd, '.namzu'),
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
		agentIds: allowedAgentIds,
		instructionFiles: projectInstructions.files.map((f) => f.path),
		skippedInstructionFiles: projectInstructions.skipped,
		mcpConnected: mcp.connected,
		mcpFailed: mcp.failed,
		configNotices: [
			...(capabilityNotice ? [capabilityNotice] : []),
			...unresolvedNotice.map(
				(line) => `Provider chain: capabilities could not be established for ${line}.`,
			),
			...fallbackPlan.notices,
		],
		close: () => mcp.close(),
		errorHint: null,
		// Reads the same object the handler mutates, at call time.
		approvalLatched: () => approval.all,
		promptExemptTools: () => promptExemptToolNames(registry),
		send: async function* (messages, opts) {
			// Renew a lapsed OAuth token before the turn runs (no-op for valid
			// tokens and non-keychain credentials).
			await refreshTokenIfNeeded()
			// namzu identity first (so it establishes who the agent is even when
			// the credential layer prepends whatever prefix its token requires),
			// then memory read fresh each turn, then the project's own
			// instructions, then per-turn extra (active skills).
			//
			// Project instructions sit AFTER the identity block deliberately, and
			// the order is the containment: they are text off the disk of
			// whatever directory the agent was pointed at, so the rules they must
			// not be able to rewrite are established before they are read.
			//
			// The environment block is read fresh every turn, unlike the project
			// instructions, because both facts in it can change WHILE the session
			// runs — midnight passes, and the agent checks out a branch itself.
			// Its text only changes when a fact changes, so it costs a prompt-cache
			// miss exactly when a hit would have been a stale claim.
			const memoryPrompt = composeMemoryPrompt(readMemory())
			const environmentPrompt = composeEnvironmentPrompt(await readEnvironmentFacts(cwd))
			const systemPrompt =
				[
					NAMZU_IDENTITY,
					environmentPrompt,
					memoryPrompt,
					projectInstructions.prompt,
					opts?.extraSystem,
				]
					.filter((s): s is string => Boolean(s))
					.join('\n\n') || undefined
			yield* runTurn({
				provider,
				// Constructed HERE, per turn, and that is not an optimisation to
				// undo. `refreshTokenIfNeeded` above replaces the head's client
				// object when an OAuth token rotates, so a member list built once at
				// session creation would hand the kernel a client holding a token
				// that expired hours ago — and a chain whose own members are stale
				// is a fallback that fails for the reason the fallback exists to
				// survive. Building a driver is a client object, not a request.
				fallbackProviders: fallbackPlan.build(currentToken),
				model,
				tools: registry,
				scope,
				workingDirectory: cwd,
				rules: options.rules,
				permissionMode: options.permissionMode,
				approval,
				taskStore,
				systemPrompt,
				messages,
				opts,
				taskGateway: subagentGateway,
				childSteps,
			})
		},
	}
}

/**
 * Which fallbacks can serve, and what to tell the operator about the ones that
 * cannot.
 *
 * Split in two on purpose. Whether a member is USABLE is a fact about the
 * operator's configuration and is settled once, at launch, where its notice can
 * be read on a day nothing is broken. Whether a member's client object is FRESH
 * is a fact about a credential that rotates during a session, so the objects are
 * built per turn — see the call site.
 *
 * The head is not here. It is resolved above and its absence is fatal to the
 * session rather than a notice, because a chain with no head has nothing to
 * fall over FROM.
 */
interface FallbackPlan {
	readonly notices: readonly string[]
	/**
	 * The chain's tail as constructed drivers, in declared order.
	 *
	 * `headToken` is threaded through so a fallback that names the SAME provider
	 * as the head — a legitimate chain, and the one `describeInvalidChain`
	 * explicitly permits when only the model differs — is built with the token
	 * the head just refreshed rather than the one discovery found at startup.
	 */
	build(headToken: string | undefined): readonly ProviderChainMember[]
}

function planFallbacks(
	members: readonly ProviderChoice[],
	detected: readonly DetectedProvider[],
): FallbackPlan {
	const notices: string[] = []
	const usable: Array<{ readonly choice: ProviderChoice; readonly det: DetectedProvider | null }> =
		[]

	for (const [index, member] of members.entries()) {
		if (index === 0) continue
		const entry = PROVIDER_REGISTRY[member.id]
		const position = chainPositionName(index)
		if (!entry) {
			// Unreachable through `readPreferences`, which refuses an unknown id for
			// every member, not just the head. Reachable from a hand-built
			// Preferences object, which the tests do.
			notices.push(`Provider chain: ${position} "${member.id}" is not a provider namzu knows.`)
			continue
		}
		const det = findDetected(detected, member.id)
		if (entry.requiresApiKey && !det?.apiKey) {
			notices.push(
				`Provider chain: ${position} (${entry.label}) has no credential, so nothing will fall over to it. ` +
					`Set one of: ${entry.envVars.join(', ')}.`,
			)
			continue
		}
		if (!isRegistered(member.id)) {
			// `resolveChainCapabilities` already tried to register every member and
			// reported the failure as an unresolved capability. Saying it twice in
			// different words would read as two problems.
			continue
		}
		usable.push({ choice: member, det })
	}

	return {
		notices,
		build(headToken) {
			const out: ProviderChainMember[] = []
			for (const { choice, det } of usable) {
				const entry = PROVIDER_REGISTRY[choice.id]
				if (!entry) continue
				const memberModel = choice.model ?? entry.defaultModel
				try {
					const credential =
						headToken !== undefined && det?.oauth ? { ...det, apiKey: headToken } : det
					out.push({
						provider: constructProvider(choice.id, credential, memberModel),
						model: memberModel,
					})
				} catch {
					// A member that will not construct is left OUT of the chain rather
					// than pushed in to throw at call time. Its absence was already
					// reported at launch by the capability pass; a driver that
					// constructs today and not tomorrow is not a case this can name
					// better than silence.
				}
			}
			return out
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
			throw new Error(unsupportedProviderMessage(id))
	}
}

/**
 * What happened when we asked a provider for its models.
 *
 * A union rather than an array, because "the list is empty" had four causes and
 * the caller could not tell them apart: the driver has no `listModels`, the
 * provider genuinely publishes none, it did not answer inside the deadline, or
 * it errored. A picker that renders all four as "no models" tells the operator
 * something false in three of them — and the timeout case is the one where the
 * truth ("it did not answer in time") most changes what they should do next.
 */
export type ModelListing =
	| { readonly kind: 'ok'; readonly models: ReadonlyArray<{ id: string; name: string }> }
	/** The driver does not implement `listModels`. */
	| { readonly kind: 'unsupported' }
	| { readonly kind: 'timeout' }
	| { readonly kind: 'failed'; readonly reason: string }

/**
 * Ask a detected provider what models it has.
 *
 * Instantiates the provider and calls its optional `listModels()`, inside a 3s
 * race so a wedged local server or a slow catalog cannot stall the UI.
 */
export async function describeProviderModels(
	id: ProviderId,
	det: DetectedProvider,
): Promise<ModelListing> {
	try {
		// constructProvider calls ProviderRegistry.create, which throws
		// "Unsupported provider type" until the vendor package has registered
		// itself. The run path registers lazily via ensureRegistered; the
		// listing path must do the same or every provider returns nothing.
		await ensureRegistered(id)
		const provider = constructProvider(id, det, det.entry.defaultModel)
		if (typeof provider.listModels !== 'function') return { kind: 'unsupported' }

		const TIMEOUT = Symbol('timeout')
		const timeout = new Promise<typeof TIMEOUT>((resolve) =>
			setTimeout(() => resolve(TIMEOUT), 3000),
		)
		const models = await Promise.race([provider.listModels(), timeout])
		if (models === TIMEOUT) return { kind: 'timeout' }

		return { kind: 'ok', models: models.map((m) => ({ id: m.id, name: m.name || m.id })) }
	} catch (err) {
		return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) }
	}
}

/**
 * Check a key the operator just typed, without spending a turn.
 *
 * Uses the provider's own `listModels` where it has one: a successful listing
 * is proof the credential authenticates, and it costs nothing. A driver without
 * one cannot be checked cheaply, and that is reported as `unverifiable` rather
 * than dressed up as success — claiming a check that did not happen is the
 * failure this whole surface is built to avoid.
 *
 * The key never appears in the returned reason. Provider errors are passed
 * through, and a driver that echoes a credential into its own error message
 * would defeat this; that is a driver bug and not one this can paper over, so
 * the reason is also truncated.
 */
export async function verifyCredential(
	id: ProviderId,
	det: DetectedProvider,
): Promise<{ kind: 'verified' } | { kind: 'unverifiable' } | { kind: 'rejected'; reason: string }> {
	try {
		await ensureRegistered(id)
		const provider = constructProvider(id, det, det.entry.defaultModel)
		// Declared, never inferred. A driver without a probe is unverifiable —
		// including one added years from now by someone who never reads this.
		// Falling back to the listing here is precisely the defect: it reported a
		// wrong key as verified for two drivers, one because a 401 was swallowed
		// behind a hardcoded catalogue and one because its listing endpoint does
		// not authenticate at all.
		if (typeof provider.probeCredential !== 'function') return { kind: 'unverifiable' }
		await provider.probeCredential()
		return { kind: 'verified' }
	} catch (err) {
		// The server answered and said no, versus nothing was learned. Collapsing
		// these would tell an operator on broken wifi to rotate a key that is fine.
		if (isCredentialRejection(err)) {
			return { kind: 'rejected', reason: describeError(err).slice(0, 200) }
		}
		return { kind: 'unverifiable' }
	}
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

/**
 * Whether the server rejected the credential, as opposed to never being reached.
 *
 * Reads a status off the error where a driver supplies one, and falls back to
 * the message. The fallback is deliberately narrow: an unrecognised failure is
 * treated as "nothing was learned", which is the direction that cannot turn a
 * working key into a rotation request.
 */
export function isCredentialRejection(err: unknown): boolean {
	const status = (err as { status?: unknown; statusCode?: unknown } | null)?.status ??
		(err as { statusCode?: unknown } | null)?.statusCode
	if (status === 401 || status === 403) return true
	if (typeof status === 'number') return false
	return /\b(401|403|unauthorized|forbidden|invalid[ _-]?api[ _-]?key|authentication)\b/i.test(
		describeError(err),
	)
}

/**
 * The same question, flattened to a list for callers that cannot act on why.
 *
 * `providers-json` emits a JSON roster for a host UI and has always rendered an
 * empty list as "fall back to free text". That contract is unchanged, and this
 * is the one place the reason is deliberately discarded — everywhere else uses
 * `describeProviderModels` and says which case it hit.
 */
export async function listProviderModels(
	id: ProviderId,
	det: DetectedProvider,
): Promise<Array<{ id: string; name: string }>> {
	const listing = await describeProviderModels(id, det)
	return listing.kind === 'ok' ? [...listing.models] : []
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
	rules: [] as VerificationRule[],
}

/**
 * The gate for this session, with the operator's rules in it.
 *
 * `rules` was a hardcoded empty array for as long as the gate has existed, so a
 * kernel with seven rule types ran with none and every mutating call fell
 * through to the prompt. The two booleans keep their meaning: the
 * dangerous-pattern denial is the floor and outranks everything, and the
 * read-only allowance is now consulted AFTER the operator's rules, so
 * `read = "ask"` is reachable instead of silently unreachable.
 */
function gateFor(rules: readonly VerificationRule[] | undefined) {
	return { ...VERIFICATION_GATE, rules: [...(rules ?? [])] }
}

// Automatic context compression for long, tool-heavy turns: the structured
// strategy summarizes old tool results / notes once the message buffer
// crosses the trigger threshold of the MODEL CONTEXT WINDOW, keeping the most
// recent messages verbatim. A no-op for short turns; a safety net against
// unbounded context growth on long ones.
//
// `contextWindowTokens` is deliberately omitted: the SDK resolves the window
// from `runConfig.model`, which is the value the user actually chose. Pinning
// a number here would fix one window across every model the CLI can talk to.
const COMPACTION_CONFIG = {
	strategy: 'structured' as const,
	triggerThreshold: 0.7,
	resetThreshold: 0.4,
	keepRecentMessages: 6,
	// Reclaim from stale tool output before summarizing. A CLI session is
	// exactly the shape this helps most: a few enormous file reads and shell
	// dumps the agent already used, next to reasoning worth keeping verbatim.
	clearToolResults: true,
	keepRecentToolResults: 3,
	minToolResultCharsToClear: 1_000,
	maxToolResults: 30,
	maxListSize: 25,
	// Pin the opening decisions/requirements; eviction takes from the
	// middle so a long session keeps what set its direction.
	keepFirstEntries: 3,
	llmVerification: false,
	llmVerificationMaxTokens: 2048,
	richStateThreshold: 15,
	convoTextBudget: 12_000,
	maxSentencesPerTurn: 5,
	maxCharsPerNote: 500,
	maxCharsPerRequirement: 300,
	maxCharsPerTask: 400,
}

/**
 * Named rather than positional: the parameters are eleven long and four of
 * them are strings, so `workingDirectory` and `systemPrompt` would sit next
 * to each other with nothing but call order to keep them apart.
 */
interface RunTurnParams {
	readonly provider: LLMProvider
	/**
	 * The chain's tail for THIS turn. Empty means no failover, which is what a
	 * one-member chain means and what every chain meant before this existed.
	 */
	readonly fallbackProviders: readonly ProviderChainMember[]
	readonly model: string
	readonly tools: ToolRegistry
	readonly scope: RunScope
	/** Directory every filesystem tool in this turn resolves against. */
	readonly workingDirectory: string
	/** Operator rules for this run, already compiled. */
	readonly rules: readonly VerificationRule[] | undefined
	readonly permissionMode: PermissionMode | undefined
	readonly approval: { all: boolean }
	readonly taskStore: TaskStore
	readonly systemPrompt: string | undefined
	readonly messages: readonly Message[]
	readonly opts: SendOptions | undefined
	readonly taskGateway: TaskGateway | undefined
	readonly childSteps: string[]
}

async function* runTurn({
	provider,
	fallbackProviders,
	model,
	tools,
	scope,
	workingDirectory,
	rules,
	permissionMode,
	approval,
	taskStore,
	systemPrompt,
	messages,
	opts,
	taskGateway,
	childSteps,
}: RunTurnParams): AsyncIterable<AgentEvent> {
	const signal = opts?.signal
	try {
		const events = query({
			provider,
			// Omitted rather than empty when there is no tail. `query` treats the
			// two the same, but an absent option reads as "this run has no chain"
			// where `[]` reads as "this run has a chain with nothing in it".
			...(fallbackProviders.length > 0 ? { fallbackProviders } : {}),
			tools,
			taskStore,
			...(taskGateway ? { taskGateway } : {}),
			// `gateFor`, not the bare default: the default's `rules` is a hardcoded
			// empty array, so passing it here discarded the operator's rules on the
			// path that runs every top-level turn. The sub-agent path called
			// `gateFor` and this one did not.
			verificationGate: gateFor(rules),
			compactionConfig: COMPACTION_CONFIG,
			// The CLI owns its process end to end, so it can safely hand the
			// termination path to the kernel: a Ctrl-C mid-run now leaves a
			// dump under .namzu/emergency/ instead of losing the turn.
			emergencySave: true,
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
			workingDirectory,
			// The exemption reads `tools` at decision time, so it sees the task
			// tools `query()` registers deferred below and any tool server that
			// connected after this session was built.
			resumeHandler: makeResumeHandler(
				approval,
				opts?.onPermission,
				permissionMode,
				(name, input) => isPromptExempt(tools, name, input),
			),
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
	mode: PermissionMode = onPermission ? 'prompt' : 'auto',
	/**
	 * Which calls skip the prompt. Injected rather than reached for, so this
	 * handler stays testable without a registry — and so the answer comes from
	 * the live roster at the moment of the call.
	 */
	exempt: (name: string, input: unknown) => boolean = () => false,
): ResumeHandler {
	return async (request): Promise<HITLResumeDecision> => {
		if (request.type !== 'tool_review') {
			return request.type === 'plan_approval' ? { action: 'approve_plan' } : { action: 'continue' }
		}
		// Only calls the gate routed to REVIEW arrive here — a rule that denied
		// one already stopped it, and a rule that allowed one never asked. So the
		// mode decides what happens to the undecided, and cannot reopen anything
		// a rule closed. That is the whole precedence story between a flag and a
		// config file, and it is one sentence on purpose.
		if (!batchNeedsPrompt(request.toolCalls, exempt)) {
			return { action: 'approve_tools' }
		}
		if (mode === 'strict') {
			return {
				action: 'reject_tools',
				feedback:
					'Refused: this run only permits tools an explicit rule allows, and no rule covers this call. Asking again will not change it — either the operator adds a rule, or this has to be done another way.',
			}
		}
		if (mode === 'auto' || !onPermission || approval.all) {
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
 * Writes that skip the prompt anyway, in spite of declaring `readOnly: false`.
 *
 * This is an OVERRIDE of the tool's own declaration, and it is named as one.
 * The list it replaced was called `READ_ONLY_TOOLS` and contained three tools
 * that declare `readOnly: false` — a constant asserting the exact property it
 * was getting wrong, which is how the disagreement survived: nothing reading it
 * had reason to doubt the name.
 *
 * The bar for an entry is that prompting would be unusable AND a bad write
 * cannot reach beyond the agent's own bookkeeping. Each one is justified here,
 * or it does not belong here.
 *
 * - `task_create` / `task_update` — the model's own plan for the current
 *   request, written several times per planning turn; prompting each would put
 *   a consent dialog between the agent and its todo list. What a bad write
 *   costs is a polluted task list, which is visible in the transcript and
 *   grants nothing. Worth knowing while reading that: these DO outlive the
 *   session, because the CLI's task store uses a fixed run id
 *   (`run_namzu-cli`), so "run-scoped" is not the reason they are here — the
 *   blast radius is.
 *
 * `save_memory` was on the list it replaced and is deliberately NOT here. Its
 * effect outlives the run in a way the task tools' does not: content saved now
 * is retrievable by `search_memory` in a later session, so a tool result or
 * fetched page that talks the model into saving something reaches a future
 * run's reasoning. It is not auto-injected into the prompt — that is
 * `MEMORY.md`, a different thing — but retrievable is enough. A write that
 * survives the process, into the user's own repository, is not read-only under
 * any reading, and it now prompts.
 */
const PROMPT_EXEMPT_WRITES = new Set(['task_create', 'task_update'])

/**
 * Whether a call runs without asking: it declares itself read-only, or it is a
 * named exemption above.
 *
 * The read-only half comes from the tool's own `isReadOnly(input)`, never from
 * a list of names kept here. A name list in the consumer is a second source of
 * truth for a property the producer already states: a new read-only tool
 * missing from it merely gets prompted, but a RENAMED tool silently changes
 * posture with nothing to notice.
 *
 * Resolved per call rather than snapshotted, because the roster changes after
 * this module has run — the task tools are registered deferred inside
 * `query()`, and tool servers connect during startup, so anything computed
 * eagerly would be answering about a registry that no longer exists.
 *
 * A tool the registry does not know, or one that declares nothing, prompts.
 * That is the safe-by-default direction the previous comment claimed and this
 * keeps: consent is the answer when the question cannot be established.
 */
export function isPromptExempt(registry: ToolRegistry, name: string, input: unknown): boolean {
	if (PROMPT_EXEMPT_WRITES.has(name.toLowerCase())) return true
	const tool = registry.get(name) ?? registry.get(name.toLowerCase())
	return tool?.isReadOnly?.(input) ?? false
}

/** The exempt roster, sorted, for the surface that has to NAME it. */
export function promptExemptToolNames(registry: ToolRegistry): readonly string[] {
	return registry
		.getCallableTools()
		.filter((t) => isPromptExempt(registry, t.name, {}))
		.map((t) => t.name)
		.sort()
}

/**
 * A batch needs explicit approval when any call mutates state: flagged
 * destructive by the SDK, or not exempt from the prompt.
 */
export function batchNeedsPrompt(
	toolCalls: readonly ToolCallSummary[],
	exempt: (name: string, input: unknown) => boolean,
): boolean {
	return toolCalls.some((tc) => tc.isDestructive || !exempt(tc.name, tc.input))
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
			// The context figures are forwarded, not recomputed. They were
			// dropped here for as long as the status gauge existed, which left
			// the bar dividing cumulative spend by a model-name guess — the one
			// number on screen that got LESS accurate the longer a session ran.
			// Spread conditionally: absent has to stay absent, because the
			// renderer's whole contract is that it shows no proportion it
			// cannot ground, and a `0` here would ground a wrong one.
			return {
				kind: 'usage',
				totalTokens: event.usage.totalTokens,
				costUsd: event.cost.totalCost,
				...(event.contextTokens !== undefined ? { contextTokens: event.contextTokens } : {}),
				...(event.contextMeasuredBy !== undefined
					? { contextMeasuredBy: event.contextMeasuredBy }
					: {}),
				...(event.contextWindowTokens !== undefined
					? { contextWindowTokens: event.contextWindowTokens }
					: {}),
				...(event.windowSource !== undefined ? { windowSource: event.windowSource } : {}),
			}
		case 'provider_fallback':
			return { kind: 'provider-fallback', text: describeFallback(event) }
		case 'task_created':
			return { kind: 'task', subject: event.subject, status: event.status }
		case 'task_updated':
			// Only surface completions — skip pending/in-progress churn so the
			// transcript shows "todo added" then "todo done", not every flip.
			return event.status === 'completed'
				? { kind: 'task', subject: event.subject, status: event.status }
				: null
		case 'run_completed':
			// Carried through rather than dropped: `run_failed` fires only from
			// the throw path, so this event is also how a budget stop, a
			// timeout, a cancellation and a blocked output guardrail arrive. A
			// consumer that reads this as success reports one for a run whose
			// answer was refused.
			return { kind: 'done', ...(event.stopReason ? { stopReason: event.stopReason } : {}) }
		case 'run_failed':
			// The classification is now carried on the event rather than
			// having been flattened away upstream. Shown because "rate
			// limited, retryable" and "your key is wrong" are the same
			// sentence to a reader who only gets the message.
			return {
				kind: 'error',
				message: event.failure ? `[${event.failure.code}] ${event.error}` : event.error,
			}
		case 'compaction_completed':
			return { kind: 'context', text: describeCompaction(event), shed: true }
		case 'compaction_failed':
			return { kind: 'context', text: describeCompactionFailure(event), shed: false }
		default:
			return null
	}
}

/**
 * What a completed compaction may honestly claim.
 *
 * Only what is checkable: which counts became which. Compaction summarises, so
 * it cannot enumerate what was lost — the loss is fidelity, not a set of
 * removable items, and "removed the file contents from turns 3-8" is a claim
 * that cannot be substantiated and is worse than silence the first time it is
 * subtly wrong.
 *
 * `measuredBy` is carried for the same reason: an estimate quoted as a
 * measurement is that same lie in miniature, and the kernel already knows which
 * it had.
 */
function describeCompaction(event: {
	messagesBefore: number
	messagesAfter: number
	tokensBefore: number
	tokensAfter: number
	measuredBy: 'provider' | 'estimate'
}): string {
	const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
	const qualifier = event.measuredBy === 'estimate' ? ' (estimated)' : ''
	return `context compacted — ${event.messagesBefore} messages replaced by ${event.messagesAfter}, ~${k(event.tokensBefore)} → ~${k(event.tokensAfter)} tokens${qualifier}`
}

/**
 * What a declined compaction says, which is three different things.
 *
 * Collapsing them into "compaction failed" would put the reader back where the
 * silence did — the same reason a rule denial had to quote the rule rather than
 * name its type. One may work next pass, one will decline identically forever,
 * and one is a bug in the reducer with no user action at all.
 *
 * Every case states that the history is unchanged, because the kernel installs
 * a reduction whole or not at all. That is a fact worth giving the reader
 * rather than making them wonder what survived.
 */
function describeCompactionFailure(event: {
	cause: 'reducer_threw' | 'shed_nothing' | 'split_tool_pair'
	messages: number
	error?: string
}): string {
	const held = `${event.messages} messages unchanged`
	switch (event.cause) {
		case 'reducer_threw':
			return `context not compacted — the reducer failed${event.error ? `: ${event.error}` : ''}. ${held}; a later pass may succeed`
		case 'shed_nothing':
			// Deliberately not phrased as an error. An irreducible history is a
			// true statement about the conversation, and dressing it as a
			// failure sends someone looking for a bug that is not there.
			return `context could not be reduced further — nothing left to shed. ${held}; later passes will answer the same`
		case 'split_tool_pair':
			// No suggested action, because there is none for the user. Offering
			// one would be worse than silence.
			return `context not compacted — the reducer produced a history splitting a tool call from its result, so it was refused. ${held}; this is a bug in the reducer`
	}
}

/**
 * Why a member could not serve, in the operator's words rather than the
 * kernel's.
 *
 * The classified code is a vocabulary for the runtime — `rate_limit` tells the
 * retry loop what to do and tells an operator nothing about what they should do.
 * The classification is not re-derived here; only the sentence for it is
 * chosen, and the code itself is still printed so a bug report carries the term
 * the logs use.
 */
const FALLBACK_REASONS: Readonly<Record<string, string>> = {
	rate_limit: 'it rate limited this run and the retries did not clear it',
	overloaded: 'it was overloaded and the retries did not clear it',
	server_error: 'it kept failing and the retries did not clear it',
	timeout: 'it did not answer in time',
	network: 'it could not be reached',
	auth: 'it rejected the credential',
	not_found: 'it does not have that model',
	unknown: 'it failed in a way namzu could not classify',
}

/**
 * The one line an operator reads when their run changes hands.
 *
 * Both members are named with their chain position, because naming only the
 * replacement leaves an operator with four declared members unable to tell
 * which one went down — and that is the only part of this they can act on.
 */
function describeFallback(event: {
	fromIndex: number
	fromProviderId: string
	fromModel?: string
	toIndex: number
	toProviderId: string
	toModel?: string
	code: string
	status?: number
}): string {
	const name = (index: number, id: string, model?: string): string => {
		const label = PROVIDER_REGISTRY[id as ProviderId]?.label ?? id
		return `${chainPositionName(index)} — ${label}${model ? `, ${model}` : ''}`
	}
	const why = FALLBACK_REASONS[event.code] ?? `it failed (${event.code})`
	const status = event.status !== undefined ? ` HTTP ${event.status},` : ''
	return (
		`Provider chain: ${name(event.fromIndex, event.fromProviderId, event.fromModel)} — could not serve:` +
		`${status} ${why} (${event.code}). ` +
		`${name(event.toIndex, event.toProviderId, event.toModel)} — is serving the rest of this turn.`
	)
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
			pick('command') ??
			pick('path') ??
			pick('file_path') ??
			pick('pattern') ??
			pick('query') ??
			// Last, so it only speaks for a tool none of the above describe.
			// Those tools were falling through to a truncated `JSON.stringify`
			// — which is how `Agent` came to show a blob of its own arguments
			// while requiring the model to write a label nothing then read.
			// Every input named `description` in this tree is a short
			// human-facing label, so it is a summary by construction.
			pick('description')
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
		const oldString = str('old_string')
		const newString = str('new_string')
		const lines: string[] = []
		if (oldString) for (const line of previewLines(oldString, 4)) lines.push(`- ${line}`)
		if (newString) for (const line of previewLines(newString, 4)) lines.push(`+ ${line}`)
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
	const name = toolName.toLowerCase()
	if (name === 'write') {
		const content = str('content')
		return content !== undefined ? clampLines(content) : undefined
	}
	if (name === 'edit') {
		const oldString = str('old_string')
		const newString = str('new_string')
		const lines: string[] = []
		if (oldString) for (const line of clampLines(oldString)) lines.push(`- ${line}`)
		if (newString) for (const line of clampLines(newString)) lines.push(`+ ${line}`)
		return lines.length > 0 ? lines : undefined
	}
	return undefined
}

/** Parse a string as a JSON object, or null. Connector tools return JSON. */
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

/**
 * Strip the bash tool's `STDOUT:` / `STDERR:` section labels so command output
 * reads as plain text (the ✗ glyph already signals a non-zero exit). Other
 * text passes through unchanged.
 */
function cleanToolText(s: string): string {
	if (!/^STDOUT:|(?:^|\n)STDERR:/.test(s)) return s
	return s
		.replace(/^STDOUT:\n?/, '')
		.replace(/\n{0,2}STDERR:\n?/, '\n')
		.trim()
}

/** Unwrap a tool's payload string from its JSON envelope, if any. */
function payloadString(result: string): string | null {
	const obj = parseJsonObject(result)
	if (!obj) return null
	const inner = obj.output ?? obj.result ?? obj.content ?? obj.text
	if (typeof inner === 'string' && inner.trim().length > 0) return cleanToolText(inner.trim())
	return null
}

/** Pretty-print JSON tool output; otherwise return the raw text as lines. */
function resultToLines(result: string): string[] {
	const payload = payloadString(result)
	if (payload !== null) return clampLines(payload)
	const obj = parseJsonObject(result)
	if (obj) return clampLines(JSON.stringify(obj, null, 2))
	return clampLines(cleanToolText(result.trim()))
}

/**
 * Output shown under a tool RESULT (`⎿`). For `edit`/`write` the diff was
 * already shown at call time, so the result stays a one-line confirmation;
 * every other tool (read/bash/grep/…) shows its captured output here — JSON
 * results are pretty-printed / unwrapped so they don't read as a raw blob.
 */
export function toolEndDetail(toolName: string, result: string): readonly string[] | undefined {
	const name = toolName.toLowerCase()
	if (name === 'edit' || name === 'write') return undefined
	if (result.trim().length === 0) return undefined
	const lines = resultToLines(result)
	// A single short line is already the summary — no need to repeat it.
	return lines.length <= 1 ? undefined : lines
}

/** Concise one-line summary of a tool result for the `⎿` line. */
function firstLine(result: string): string {
	const payload = payloadString(result)
	if (payload !== null) {
		return truncate(payload.split('\n').find((l) => l.trim().length > 0) ?? '', 120)
	}
	const obj = parseJsonObject(result)
	if (obj) {
		if (obj.success === false && typeof obj.error === 'string') return truncate(obj.error, 120)
		const keys = Object.keys(obj)
		return keys.length > 0
			? `{ ${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', …' : ''} }`
			: '{}'
	}
	const cleaned = cleanToolText(result.trim())
	return truncate(cleaned.split('\n').find((l) => l.trim().length > 0) ?? '', 120)
}

function emptySession(errorHint: string): AgentSession {
	return {
		hasProvider: false,
		providerSummary: null,
		modelSummary: null,
		toolNames: [],
		// No provider, so no runtime was built and there is nothing to delegate
		// to — the same reason `toolNames` is empty.
		agentIds: [],
		// Nothing was injected, because no turn will run. Reporting files here
		// would claim instructions are in force on a session that has no prompt.
		instructionFiles: [],
		skippedInstructionFiles: [],
		mcpConnected: [],
		mcpFailed: [],
		// Nothing ran, so there is no configuration in force to report on.
		configNotices: [],
		errorHint,
		// No turn can run here, so no prompt can have been answered.
		approvalLatched: () => false,
		// No registry was built, so there is no roster to report on.
		promptExemptTools: () => [],
		send: async function* () {
			yield { kind: 'error' as const, message: errorHint }
		},
		close: async () => {
			// Nothing was ever connected on this path.
		},
	}
}
