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
	type AuthorizationRule,
	BOOT_EVENT_NAMES,
	type CheckpointStore,
	type CompactionConfig,
	type CompactionResult,
	type CostInfo,
	DefaultPathBuilder,
	DiskMemoryStore,
	DiskTaskStore,
	type DurableRunEntry,
	EVENT_NAME_ATTRIBUTE,
	type FencingToken,
	type GoalRoundAuthority,
	GuardedFetchProvider,
	type LLMProvider,
	type LogAttributes,
	type Message,
	type ModelInfo,
	type PluginLifecycleManager,
	type ProjectId,
	type ProjectInstructionContext,
	type PromoteMemory,
	PromptContributionRegistry,
	type ProviderChainMember,
	ProviderRegistry,
	type ReasoningEffort,
	type ResumeHandler,
	type ResumeOutcome,
	type ReviewAnswer,
	type RunEvent,
	type RunId,
	SESSION_GOAL_TOOL_NAMES,
	type SandboxProvider,
	SearchToolsTool,
	type SessionGoalStore,
	type SessionId,
	type Skill,
	type SkillRegistry,
	type StopReason,
	type TaskScheduler,
	type TaskStore,
	type TenantId,
	type ToolCallView,
	type ToolDefinition,
	type ToolPresenter,
	ToolRegistry,
	type ToolResultView,
	type ToolReviewAnswer,
	type ToolReviewPrompt,
	type ToolReviewRequest,
	type TopicId,
	WebFetchTool,
	asProjectId,
	asRunId,
	asSessionId,
	asTenantId,
	asTopicId,
	batchNeedsReview,
	buildAskUserQuestionTool,
	buildMemoryTools,
	buildSessionGoalTools,
	compactNow,
	createComputerUseTool,
	createMemoryPromoter,
	createReviewHandler,
	createToolPresenter,
	generateRunId,
	getBuiltinTools,
	isReviewExempt,
	query,
	resumeRun,
	webGuidanceContribution,
	withProviderFallback,
} from '@namzu/sdk'

import { SubprocessComputerUseHost } from '@namzu/computer-use'

import { realpath, stat } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'
import type {
	CompactionCliConfig,
	HooksConfig,
	PluginConfig,
	SandboxConfig,
	WebConfig,
} from '../config/schema.js'
import { type CapabilityProbe, probeCapabilities } from '../context/capabilities.js'
import {
	NAMZU_DELEGATION_DOCTRINE,
	NAMZU_PLAN_MODE_DOCTRINE,
	NAMZU_WORKING_DOCTRINE,
} from '../context/doctrine.js'
import { composeEnvironmentPrompt, readEnvironmentFacts } from '../context/environment.js'
import { ProjectInstructionTracker } from '../context/project-tracker.js'
import {
	type ResolvedSandbox,
	type SandboxSummary,
	resolveSandbox,
	sandboxResolvedSeverity,
} from '../context/sandbox.js'
import { composeTurnSnapshot, readTurnSnapshot } from '../context/turn-snapshot.js'
import {
	type ConnectedMcpServer,
	type FailedMcpServer,
	type McpServersConfig,
	connectMcpServers,
} from '../integrations/mcp/servers.js'
import { createCliPluginRuntime } from '../integrations/plugins/runtime.js'
import {
	type AgentOAuthCredential,
	CredentialRefreshRejectedError,
	CredentialWithdrawnError,
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
	ensureFreshStoredCodexCredential,
	ensureRegistered,
	findDetected,
	isAnthropicOAuthToken,
	isRegistered,
	missingCredentialMessage,
	primaryProvider,
	readCodexCredentialFile,
	readPreferences,
	readSubscriptionCredential,
	resolveChainCapabilities,
	sameOAuthCredential,
	unresolvedMembers,
	unsupportedProviderMessage,
} from '../integrations/providers/index.js'
import { ensurePrivateStateDirectory } from '../integrations/state/private-directory.js'
import type { SubagentActivitySource } from '../integrations/subagents/activity.js'
import { discoverAgentDefinitions } from '../integrations/subagents/definitions.js'
import { CLI_INTERACTIVE_RUN_TIMEOUT_MS } from '../integrations/subagents/policy.js'
import { type SubagentRuntime, createSubagentRuntime } from '../integrations/subagents/runtime.js'
import { cliLogger } from '../logging.js'
import { composeMemoryPrompt, readMemory } from '../memory/store.js'
import type { PermissionMode } from '../permissions/mode.js'
import { projectRunConversation } from './conversation-history.js'

export type AgentEvent =
	| {
			readonly kind: 'delta'
			readonly text: string
			/**
			 * The assistant message this text belongs to.
			 *
			 * Carried across the seam because `/feedback` rates a MESSAGE, and
			 * the id is the only thing that ties a rating to what was actually
			 * said. It was dropped here — the kernel emits it on every
			 * `text_delta` and this mapper threw it away — so the host had no
			 * way to name the answer it was looking at.
			 */
			readonly messageId?: string
			/** The run that produced it — a rating names both. */
			readonly runId?: string
	  }
	| {
			readonly kind: 'tool-start'
			/** Run-scopes provider tool ids, which are not globally unique. */
			readonly runId?: string
			/** SDK tool-use id — stable across this call's start/end (for tracking). */
			readonly toolUseId: string
			readonly toolName: string
			readonly summary: string
			/** The tool authored a complete activity label; do not wrap its registry name. */
			readonly standalone?: boolean
			/** Diff / content preview shown (collapsible) under the call. */
			readonly detail?: readonly string[]
	  }
	| {
			readonly kind: 'tool-progress'
			readonly runId?: string
			readonly toolUseId: string
			readonly toolName: string
			/** Bounded latest-state text from the executing tool. */
			readonly message: string
			readonly fraction?: number
	  }
	| {
			readonly kind: 'tool-end'
			readonly runId?: string
			readonly toolUseId: string
			readonly toolName: string
			readonly isError: boolean
			readonly summary: string
			/** Kernel-measured execution time; independent of host event buffering. */
			readonly durationMs?: number
			/** A successful result intentionally adds no second transcript row. */
			readonly hidden?: boolean
			/** Output lines shown (collapsible) under the result. */
			readonly detail?: readonly string[]
	  }
	/**
	 * The model thinking, for the live region only. `text` is a delta;
	 * `done` marks the end of a block. Never a transcript row: reasoning is
	 * ephemeral in the kernel's own transcript and is shown here for the
	 * same reason a spinner is — so a long silence reads as work.
	 */
	| {
			readonly kind: 'reasoning'
			readonly text: string
			readonly done?: boolean
	  }
	| {
			readonly kind: 'usage'
			/** CUMULATIVE run spend. Grows every turn; never a context size. */
			readonly totalTokens: number
			/**
			 * The kernel's cost record, carried whole.
			 *
			 * This was `costUsd: number`, narrowed from the same object at the
			 * mapping site, and the number on its own cannot answer the
			 * question the screen asks. A total of zero means two different
			 * things — the run cost nothing, or nobody could price it — and
			 * `unpricedTokens` is what separates them. Passing only the total
			 * left every surface downstream to guess, and both of them guessed
			 * "free".
			 */
			readonly cost: CostInfo
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
			readonly windowSource?: 'config' | 'provider' | 'model-table' | 'default'
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
	| {
			readonly kind: 'capability-warning'
			readonly capability: Extract<RunEvent, { type: 'capability_warning' }>['capability']
			readonly contentSource?: Extract<RunEvent, { type: 'capability_warning' }>['contentSource']
			readonly text: string
	  }
	| {
			readonly kind: 'history-repair'
			readonly source: Extract<RunEvent, { type: 'message_history_repaired' }>['source']
			readonly text: string
	  }
	/**
	 * One task of the model's plan, on every change. `taskId` is what lets the
	 * live list update a row in place rather than append; `status` is the
	 * store's own vocabulary. The transcript still records only the opening
	 * and the close — the churn in between is for the list, not the record.
	 */
	| {
			readonly kind: 'task'
			readonly taskId: string
			readonly subject: string
			readonly status: 'pending' | 'in_progress' | 'completed' | 'failed'
	  }
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
	| {
			/** A recoverable run stopped with an addressable checkpoint. */
			readonly kind: 'paused'
			readonly checkpointId: string
			readonly reason: string
			readonly failure?: Extract<RunEvent, { type: 'run_paused' }>['failure']
			readonly providerError?: Extract<RunEvent, { type: 'run_paused' }>['providerError']
			readonly explanation?: Extract<RunEvent, { type: 'run_paused' }>['explanation']
	  }
	| {
			readonly kind: 'error'
			readonly message: string
			readonly failure?: Extract<RunEvent, { type: 'run_failed' }>['failure']
			readonly providerError?: Extract<RunEvent, { type: 'run_failed' }>['providerError']
			readonly explanation?: Extract<RunEvent, { type: 'run_failed' }>['explanation']
	  }

/** A single tool the model wants to run, surfaced to the user for approval. */
export interface PermissionToolCall {
	readonly id: string
	readonly name: string
	/** Exact detached input the kernel prepared and the approval covers. */
	readonly input: unknown
	readonly isDestructive: boolean
}

/** The batch a person is asked about — the kernel's `ToolReviewRequest`. */
export type PermissionRequest = ToolReviewRequest
export type PermissionDecision = ToolReviewAnswer
export type PermissionFn = ToolReviewPrompt

/** One question the model put to the operator through `ask_user_question`. */
export type UserQuestion = Extract<
	Parameters<ResumeHandler>[0],
	{ type: 'user_question' }
>['question']

/**
 * What the operator did with a question. `skip` is "did not answer" — the
 * tool tells the model so and the model proceeds on its own judgment;
 * `abort` is "stop asking and stop the turn".
 */
export type QuestionAnswer =
	| {
			readonly kind: 'answer'
			readonly selectedOptionIds: readonly string[]
			readonly freeText?: string
	  }
	| { readonly kind: 'skip' }
	| { readonly kind: 'abort' }

export type QuestionFn = (question: UserQuestion) => Promise<QuestionAnswer>

export interface SendOptions {
	readonly signal?: AbortSignal
	/**
	 * Who answers `ask_user_question` this turn. Absent means nobody: the
	 * tool reports "the user did not answer" and the model carries on. The
	 * tool itself is mounted per session (`AgentSessionOptions.askUser`).
	 */
	readonly onQuestion?: QuestionFn
	/**
	 * Live user messages accepted while this turn is running.
	 *
	 * The SDK drains this callback only at provider-valid iteration boundaries;
	 * keeping it as a callback rather than an eager array preserves ownership of
	 * input that has not crossed that boundary yet.
	 */
	readonly inboundMessages?: () => Message[]
	/** Model-specific reasoning effort for this turn's main query. */
	readonly effort?: ReasoningEffort
	/**
	 * How this turn resolves review requests no declarative rule decided.
	 * Overrides the session default for this turn only.
	 */
	readonly permissionMode?: PermissionMode
	/** Caller-reserved identity used to correlate this turn before it starts. */
	readonly runId?: RunId
	/** Exact durable admission that makes goal tools visible for this one run. */
	readonly goalRound?: GoalRoundAuthority
	/**
	 * Called before a batch of non-read-only tools runs. Resolves with the
	 * user's decision. When omitted, prompt mode auto-approves because nobody
	 * can answer; strict mode still refuses and auto mode still approves.
	 */
	readonly onPermission?: PermissionFn
	/**
	 * Extra system context to inject for this turn (e.g. active skills),
	 * merged after the persistent memory block.
	 */
	readonly extraSystem?: string
	/**
	 * Receives the settled conversation projection exactly as the kernel will
	 * replay it on a later turn.
	 *
	 * Kept out of `AgentEvent`: `run-stream` writes every event to NDJSON, while
	 * this history may contain opaque reasoning signatures/encrypted blocks that
	 * belong in provider context and durable state, never a rendered stream.
	 */
	readonly onConversationMessages?: (messages: readonly Message[]) => void
}

/** What {@link AgentSession.resumeDurable} needs that the session does not hold. */
export interface ResumeDurableParams {
	/**
	 * The run to continue, straight out of a durable listing.
	 *
	 * A `DurableRunEntry` IS an addressable run scope, which is why it can be
	 * passed here unreassembled — and why there is no chance of assembling it
	 * wrong.
	 */
	readonly entry: DurableRunEntry
	/** The backend the entry came from. */
	readonly checkpointStore: CheckpointStore
	/**
	 * The fence of the claim this process holds on the run.
	 *
	 * Omit it only for a single-writer host. Present, it rides every durable
	 * write the resumed run makes, so a worker that stalled past its lease
	 * cannot overwrite the record of whoever took the run over.
	 */
	readonly claimFence?: FencingToken
	readonly signal?: AbortSignal
}

export interface AgentSession {
	readonly hasProvider: boolean
	/**
	 * What the sandbox enforces for this session.
	 *
	 * Carried on the session rather than re-resolved by whoever asks, because
	 * resolving builds a provider — and a second one would answer about a
	 * different sandbox than the one the run is using.
	 */
	readonly sandbox: SandboxSummary
	readonly providerSummary: string | null
	readonly modelSummary: string | null
	/**
	 * Exact reasoning-effort levels every usable member of this provider chain
	 * accepts for its selected model. `undefined` means at least one member
	 * cannot enumerate; `[]` is an explicit no-common-level answer.
	 *
	 * Optional for older embedded session implementations. The built-in session
	 * always publishes the field.
	 */
	readonly reasoningEffortLevels?: readonly ReasoningEffort[]
	/**
	 * The exact level used when this model receives no explicit effort.
	 *
	 * Optional because some provider/model routes cannot publish one. A
	 * directional shortcut must not guess an anchor when it is absent.
	 */
	readonly reasoningEffortDefault?: ReasoningEffort
	/**
	 * Every tool this session can call, by name, read at call time.
	 *
	 * A FUNCTION, for the reason stated one field down about `promptExemptTools`
	 * and reached here late: the roster is not final when the session is built.
	 * The task tools register deferred inside the first `query()`, so a value
	 * captured at construction names a set the operator never had — and `/tools`,
	 * whose entire job is to answer "what can this thing call", was reading
	 * exactly that captured value while `/permissions`, one command over, read
	 * the registry live. The two could disagree on the same screen: the exempt
	 * roster naming `task_create` as never-prompted, and the tool list not
	 * showing `task_create` at all.
	 *
	 * The connect line calls it at connect time and gets the same number it
	 * always did — the deferred tools genuinely are not registered yet at that
	 * moment, and a line about what just happened should say what was true then.
	 */
	readonly toolNames: () => readonly string[]
	/**
	 * Shrink a conversation on request, returning the replacement history.
	 *
	 * On the session because the session owns the provider and the compaction
	 * settings; a caller that held those to do this itself would be describing
	 * a second configuration and calling a second model.
	 *
	 * `null` when there is nothing to shed — a conversation short enough that a
	 * summary would cost a model call and save nothing. That is a real answer
	 * and the caller says so, rather than reporting a compaction that did not
	 * happen.
	 *
	 * Session close cancels and settles an in-flight pass before releasing the
	 * provider/tool resources it may still use.
	 */
	readonly compact: (messages: readonly Message[]) => Promise<CompactionResult | null>
	readonly errorHint: string | null
	/**
	 * WHY there is no provider, for a caller that has to act differently on the
	 * two answers. `null` when there is one.
	 *
	 * - `invocation` — the caller asked for something that does not exist. A
	 *   provider id that is not in the registry is the case: whoever typed it
	 *   fixes it by typing something else.
	 * - `environment` — the ask was fine and the machine cannot serve it. No
	 *   credential, a driver package that would not load, a chain that
	 *   contradicts itself, a client that would not construct. Nothing the
	 *   caller sends changes any of that; a person has to go and do something.
	 *
	 * Reported as a field rather than left to be read out of `errorHint`,
	 * because a caller that has to distinguish two conditions and is given only
	 * prose ends up matching on the message text — after which the message can
	 * never be reworded. `exit-codes.ts` makes exactly that argument about
	 * `77`, and this is the same argument one level in.
	 */
	readonly errorKind: 'invocation' | 'environment' | null
	/**
	 * Absolute paths of the `AGENTS.md` files in the session's current retained
	 * project-policy snapshot — outermost first, exactly the set now in force.
	 *
	 * This is live: a successful file operation can discover a nested scope or
	 * reload an edited file without reconnecting. Reported so a surface can tell
	 * the user which project instructions are in force. A user who cannot see
	 * this has no way to distinguish "namzu read my conventions and disagreed"
	 * from "namzu never saw them", and those call for opposite responses.
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
	readonly skippedInstructionFiles: readonly {
		readonly path: string
		readonly reason: string
	}[]
	/** External tool servers whose transports are connected right now. */
	readonly mcpConnected: readonly ConnectedMcpServer[]
	/**
	 * External tool servers that are NOT available right now, with why.
	 *
	 * The hazard this feature carries is an operator who declares a server,
	 * watches the agent run without its tools and concludes the model is bad at
	 * the task. An empty tool list is not a signal; a named failure is.
	 */
	readonly mcpFailed: readonly FailedMcpServer[]
	/** One coherent present-tense view for operator surfaces such as `/mcp`. */
	readonly mcpStatus?: () => {
		readonly connected: readonly ConnectedMcpServer[]
		readonly failed: readonly FailedMcpServer[]
	}
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
	/** Children created in this process, available for the TUI's observational view. */
	readonly subagents?: SubagentActivitySource
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
	 * Revoke a prior "approve all" choice before a later turn starts. Optional
	 * only for older embedded AgentSession implementations; App refuses a mode
	 * change when this capability is absent rather than pretending it revoked.
	 */
	readonly resetApprovalLatch?: () => void
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
	 * Continue a run some OTHER process started, from its durable state.
	 *
	 * The kernel could always do this — `resumeRun` joins a checkpoint back
	 * to a running loop — and nothing in this package could reach it, because
	 * the half a snapshot cannot carry (the provider client, the tool
	 * registry, the working directory) lives inside this session and had no
	 * way out. So `namzu` could produce durable runs and never pick one up.
	 *
	 * Returns the outcome rather than a stream: `resumeRun` drains the loop
	 * and hands back a settled run, so there is nothing to render as it
	 * happens. A parked run comes back as `awaiting-decision` and is NOT
	 * resumed past — the answer is a human's, not a drainer's.
	 */
	resumeDurable(params: ResumeDurableParams): Promise<ResumeOutcome>
	/**
	 * Cancel and settle live sends, compactions and durable resumes, then release
	 * what the session holds — today, the external tool servers.
	 *
	 * A stdio server is a CHILD PROCESS, and closing it while a live run still
	 * owns one of its tools is a use-after-close race. Idempotent, waits for the
	 * operations it cancelled, and safe to call on a session that connected
	 * nothing. Calls made after close refuse before provider work starts.
	 */
	close(): Promise<void>
}

export interface AgentSessionContext {
	readonly preferences: Preferences | null
	readonly needsRepickReason: string | null
	readonly detected: readonly DetectedProvider[]
	/**
	 * The saved chain is fine and the MACHINE has no credential for its primary.
	 *
	 * A separate field rather than a second flavour of `needsRepickReason`, and
	 * separate from nulling `preferences`, because the three readers of this
	 * object want different things from it:
	 *
	 *  - the TUI routes into the picker, where the operator can enter a
	 *    credential or choose something else;
	 *  - `run`, `run-stream` and `drain` do `probe.preferences ?? defaultPrefs(...)`,
	 *    so nulling preferences here would silently move a scripted run onto
	 *    whatever else happened to be detected — the opposite of a refusal;
	 *  - `createAgentSession` refuses again on its own, which is what keeps those
	 *    headless exit codes and their `errorKind` classification unchanged.
	 *
	 * Carries the provider id as well as the sentence: a surface that offers to
	 * take a credential has to know which provider it is for, and re-deriving
	 * that from `preferences` at the call site is the same lookup in a second
	 * place.
	 */
	readonly credentialGap: {
		readonly providerId: ProviderId
		readonly reason: string
	} | null
}

/**
 * Let one caller stop waiting without cutting a shared queue in the middle.
 *
 * The queued operation remains chained and owns its own signal. This observer
 * only settles the caller promptly; releasing a queue slot here would allow a
 * later owner to overlap the operation still ahead of it.
 */
async function observeWithSignal<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted()
	let rejectAbort: (reason: unknown) => void = () => {}
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject
	})
	const onAbort = () => rejectAbort(signal.reason)
	signal.addEventListener('abort', onAbort, { once: true })
	if (signal.aborted) onAbort()
	try {
		return await Promise.race([operation, aborted])
	} finally {
		signal.removeEventListener('abort', onAbort)
	}
}

/**
 * Own every asynchronous operation that can still touch a session resource.
 *
 * A caller-owned signal remains caller-owned: closing the session aborts the
 * fused operation signal, never the controller the caller passed. Streams are
 * registered when handed out rather than when first pulled, so a consumer that
 * abandons one between yields cannot leave the session's provider/tool owners
 * alive past `close()`.
 */
export class SessionOperationOwner {
	private readonly lifetime = new AbortController()
	private readonly active = new Set<Promise<void>>()
	private readonly streamClosers = new Set<() => Promise<void>>()
	private readonly closeReason = new DOMException('Agent session closed.', 'AbortError')
	private closed = false
	private closePromise: Promise<void> | undefined

	constructor(private readonly cleanup: () => Promise<void>) {}

	promise<T>(
		callerSignal: AbortSignal | undefined,
		start: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		let signal: AbortSignal
		try {
			signal = this.operationSignal(callerSignal)
		} catch (error) {
			return Promise.reject(error)
		}

		const operation = Promise.resolve().then(() => {
			signal.throwIfAborted()
			return start(signal)
		})
		this.track(operation)
		return operation
	}

	stream<T>(
		callerSignal: AbortSignal | undefined,
		start: (signal: AbortSignal) => AsyncIterable<T>,
	): AsyncIterable<T> {
		let signal: AbortSignal
		try {
			signal = this.operationSignal(callerSignal)
		} catch (error) {
			return {
				[Symbol.asyncIterator]() {
					return {
						next: () => Promise.reject(error),
					}
				},
			}
		}

		const source = (async function* () {
			signal.throwIfAborted()
			yield* start(signal)
		})()[Symbol.asyncIterator]()
		let settled = false
		let settle!: () => void
		const settlement = new Promise<void>((resolve) => {
			settle = resolve
		})
		let operationTail = Promise.resolve()
		let returnStarted = false
		let closeStreamPromise: Promise<void> | undefined
		const finish = () => {
			if (settled) return
			settled = true
			this.streamClosers.delete(closeStream)
			settle()
		}
		const enqueue = <R>(operation: () => Promise<R>): Promise<R> => {
			const result = operationTail.then(operation)
			operationTail = result.then(
				() => {},
				() => {},
			)
			return result
		}
		const observe = async (
			operation: () => Promise<IteratorResult<T>>,
		): Promise<IteratorResult<T>> => {
			try {
				const result = await enqueue(operation)
				if (result.done) finish()
				return result
			} catch (error) {
				finish()
				throw error
			}
		}
		const requestReturn = (value?: unknown): Promise<IteratorResult<T>> => {
			return observe(async () => {
				returnStarted = true
				return source.return
					? await source.return(value as never)
					: ({ done: true, value } as IteratorResult<T>)
			})
		}
		const closeStream = (): Promise<void> => {
			if (closeStreamPromise) return closeStreamPromise
			closeStreamPromise = (async () => {
				try {
					await enqueue(async () => {
						if (settled) return
						let result: IteratorResult<T>
						if (returnStarted) {
							result = await source.next()
						} else if (source.return) {
							returnStarted = true
							result = await source.return(undefined as never)
						} else {
							return
						}
						while (!result.done) result = await source.next()
					})
				} finally {
					finish()
				}
			})()
			return closeStreamPromise
		}
		const managed: AsyncIterableIterator<T> = {
			next: (value?: unknown) => observe(() => source.next(value as never)),
			return: requestReturn,
			throw: (error?: unknown) =>
				observe(async () => {
					if (source.throw) return await source.throw(error)
					throw error
				}),
			[Symbol.asyncIterator]() {
				return this
			},
		}

		this.streamClosers.add(closeStream)
		this.track(settlement)
		return managed
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise
		this.closed = true
		this.lifetime.abort(this.closeReason)
		this.closePromise = this.finishClose()
		return this.closePromise
	}

	private operationSignal(callerSignal: AbortSignal | undefined): AbortSignal {
		if (this.closed) throw this.closeReason
		return callerSignal
			? AbortSignal.any([callerSignal, this.lifetime.signal])
			: this.lifetime.signal
	}

	private track(operation: PromiseLike<unknown>): void {
		const settlement = Promise.resolve(operation).then(
			() => {},
			() => {},
		)
		this.active.add(settlement)
		void settlement.then(() => this.active.delete(settlement))
	}

	private async finishClose(): Promise<void> {
		await Promise.allSettled([...this.streamClosers].map((close) => close()))
		await Promise.allSettled([...this.active])
		await this.cleanup()
	}
}

async function drainIterator(iterator: AsyncIterator<unknown>): Promise<void> {
	if (!iterator.return) return
	let result = await iterator.return(undefined as never)
	while (!result.done) result = await iterator.next()
}

/**
 * Read preferences + run discovery once. Returned context drives the
 * App's lifecycle decision: ready / picker / unhealthy.
 */
export async function probeAgentSession(): Promise<AgentSessionContext> {
	const read = readPreferences()
	// Bracketed in the log because this is where a boot has stalled without
	// a record on either side: it reads credential files, and on WSL it asks
	// Windows for the paired home. A hang that shows the last line before it
	// and nothing after is this step.
	const discoveryStartedAt = Date.now()
	cliLogger().debug('discovering provider credentials')
	const detected = await discoverProviders()
	cliLogger().debug('provider credentials discovered', {
		'namzu.boot.discovery_ms': Date.now() - discoveryStartedAt,
		'namzu.boot.detected_count': detected.length,
	})
	switch (read.status) {
		case 'ok':
			return {
				preferences: read.prefs,
				needsRepickReason: null,
				detected,
				credentialGap: credentialGap(read.prefs, detected),
			}
		case 'missing':
			return {
				preferences: null,
				needsRepickReason: null,
				detected,
				credentialGap: null,
			}
		case 'needs-repick':
			return {
				preferences: null,
				needsRepickReason: read.reason,
				detected,
				credentialGap: null,
			}
	}
}

/**
 * Whether the saved primary needs a key that discovery did not find.
 *
 * Asked HERE rather than at construction, which is where it used to be asked
 * and is the whole defect. `createAgentSession` can only answer by returning an
 * empty session, and an empty session sets the `unhealthy` phase — a disabled
 * composer from which `/model` cannot be typed. So the refusal ended with "or
 * pick another provider" printed on the one screen that will not let you. The
 * neighbouring branch, an unbuildable primary, was moved to read time for
 * exactly this reason; see `describeInvalidChain` in `preferences.ts`.
 *
 * Only the PRIMARY, matching that neighbour's asymmetry. A fallback with no
 * credential is dropped from the chain at launch with a notice (`planFallbacks`)
 * and the session still runs on the primary the operator has; taking that
 * session away over a spare would be the trade the notice already refuses.
 */
function credentialGap(
	prefs: Preferences,
	detected: readonly DetectedProvider[],
): { providerId: ProviderId; reason: string } | null {
	const primary = primaryProvider(prefs)
	const entry = PROVIDER_REGISTRY[primary.id]
	// An id that is not a provider, or one with no driver in this build, is
	// already `needs-repick` from `readPreferences` and never reaches here. If
	// one ever did, it is not a credential problem and must not be reported as
	// one — a wrong diagnosis sends the operator to paste a key that would not
	// have helped.
	if (!entry || !entry.constructible || !entry.requiresApiKey) return null
	const det = findDetected(detected, primary.id)
	if (det?.apiKey) return null
	return { providerId: primary.id, reason: missingCredentialMessage(entry) }
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
	'- Bash calls are serialized because they may mutate the same workspace. Never claim two Bash calls ran in parallel unless one command itself produced timestamped proof of overlap. Delegate genuinely independent work through the Agent tool instead.',
	'- If a capability or tool is unavailable (e.g. no web access, a tool is missing, a sub-agent failed), say so plainly and stop — do not improvise a fake result.',
	'- When you delegate with the `Agent` tool, report only what the sub-agent actually returned in its tool result; if it wrote files, verify with a tool before claiming paths.',
	'- A reply from a tool that delegates to ANOTHER agent (a connector that runs another agent, an A2A `tasks/send`, a remote peer) is that agent\'s unverified CLAIM, not fact — another model can hallucinate. If it says it ran a command, wrote a file, or "here is the output", treat that as narrative and confirm it yourself with a deterministic tool (a real shell like `bash.run`, a file read) before reporting it as done. Distinguish such conversational agent calls from deterministic tools, and never present another agent\'s prose as your own verified result.',
].join('\n')

/**
 * The registry, and the memory store behind its memory tools.
 *
 * The store used to be constructed inside this function and discarded, which
 * is why namzu could only ever remember something the model had explicitly
 * decided to write down with `save_memory`. The run's own extracted
 * knowledge had nowhere to go: `promoteMemory` is called at settle with the
 * compaction pass's structured output, and supplying it needs THIS store —
 * the same one `search_memory` reads on the next run, or a promoted memory
 * would be written somewhere nothing looks.
 */
interface BuiltTools {
	readonly registry: ToolRegistry
	readonly memoryStore: DiskMemoryStore
}

function foregroundOnlyBash(tool: ToolDefinition): ToolDefinition {
	const fullSchema = tool.inputSchema as typeof tool.inputSchema & {
		omit(mask: {
			readonly run_in_background: true
		}): ToolDefinition['inputSchema']
	}
	return {
		...tool,
		description:
			'Executes one bash command in the foreground and returns stdout/stderr. Calls are serialized because shell commands may mutate the same workspace. Use the Agent tool for genuinely independent parallel work.',
		inputSchema: fullSchema.omit({ run_in_background: true }),
		modelInputSchema: {
			type: 'object',
			properties: {
				command: {
					type: 'string',
					minLength: 1,
					description: 'The non-empty bash command to execute in the foreground.',
				},
				timeout: {
					type: 'number',
					exclusiveMinimum: 0,
					description:
						'Command timeout in milliseconds. Use a larger foreground timeout for long builds; background jobs are unavailable inside this sandbox.',
				},
			},
			required: ['command'],
			additionalProperties: false,
		},
	}
}

function builtinTools(backgroundJobs: boolean): ToolDefinition[] {
	return getBuiltinTools().flatMap((tool) => {
		if (EXCLUDED_BUILTINS.has(tool.name)) return []
		if (backgroundJobs) return [tool]
		if (tool.name === 'job') return []
		return [tool.name === 'bash' ? foregroundOnlyBash(tool) : tool]
	})
}

function buildToolRegistry(
	cwd: string,
	projectStateRoot = join(cwd, '.namzu'),
	backgroundJobs = true,
): BuiltTools {
	const registry = new ToolRegistry()
	registry.register(builtinTools(backgroundJobs))
	// SDK memory: the agent gets search_memory / read_memory / save_memory over
	// a structured store in this Project's generated-state directory. CLI
	// surfaces inject the central application-home hierarchy; embedded callers
	// that omit it retain the historical `<cwd>/.namzu` layout.
	// Separate from the user-curated MEMORY.md that is injected into the prompt.
	ensurePrivateStateDirectory(projectStateRoot, 'memory')
	const memoryStore = new DiskMemoryStore({ baseDir: projectStateRoot })
	// Search through the store's async boundary. Its concrete index is lazy:
	// handing `getIndex()` to the synchronous overload before the first store
	// read makes a new process report every persisted memory as absent.
	registry.register(buildMemoryTools(memoryStore))
	// `search_tools` is deliberately NOT registered here. It is only useful
	// where deferred tools exist, and that differs between this function's two
	// callers: the session below passes a `taskStore`, so query() registers the
	// task tools deferred and the search has a roster; a sub-agent is built with
	// no task store, so its registry has nothing deferred and the tool could
	// only ever answer "no deferred tools matching X" — a capability advertised
	// every turn that costs a turn to discover is unusable. Mounting it is the
	// caller's decision, made where the roster is known.
	return { registry, memoryStore }
}

/** Refresh plugin skill metadata before each provider operation. */
async function currentPluginSkills(registry: SkillRegistry): Promise<Skill[]> {
	const names = registry.list().map((skill) => skill.metadata.name)
	for (const name of names) await registry.load(name, 'metadata')
	return registry.list()
}

export interface AgentSessionOptions {
	/** Session/thread/project/tenant identity for this run. Minted when absent. */
	readonly scope?: RunScope
	/**
	 * The directory the agent works in: what every filesystem tool resolves a
	 * relative path against and where sub-agents run. Generated task and memory
	 * state follows {@link stateRoot}. Defaults to the process's own directory.
	 *
	 * Taken as an argument rather than read from `process.cwd()` at each of
	 * those four points, which is what let `--cwd` reach the session store and
	 * the skill search and stop there: the caller parsed a directory, the agent
	 * globbed a different one, and the run reported finding nothing rather than
	 * having looked in the wrong place.
	 */
	readonly cwd?: string
	/**
	 * Injected SDK hierarchy root for this host session. When present, runs use
	 * this exact path builder and generated memory/tasks live inside the scoped
	 * Project. Absent preserves the embedded API's historical cwd-local layout.
	 */
	readonly stateRoot?: string
	/**
	 * Operator-authored tool rules, already compiled to the kernel's vocabulary.
	 *
	 * Absent means an empty rule list, which is what the CLI passed for the
	 * gate's whole existence: every mutating call fell through to the prompt.
	 * That stays the behaviour for anyone who writes no config.
	 */
	readonly rules?: readonly AuthorizationRule[]
	/** How calls no rule decided are resolved. Defaults to prompt/auto by TTY. */
	readonly permissionMode?: PermissionMode
	/**
	 * External tool servers to connect for this session, from the operator's
	 * config. Absent means none, which is what it meant before they existed.
	 */
	readonly mcpServers?: McpServersConfig
	/** Executable extension runtime. Absent or disabled performs no discovery. */
	readonly plugins?: PluginConfig
	/**
	 * Judge the answer a turn is about to settle with, and hand it back with
	 * feedback when it is not good enough.
	 *
	 * A SESSION option rather than a `SendOptions` one, because a gate is a
	 * standing condition on the run — "don't finish until the build passes" —
	 * not a property of one message. Absent leaves the loop byte-identical.
	 */
	readonly reviewAnswer?: ReviewAnswer
	/**
	 * Rejections the reviewer is allowed before the run stops with
	 * `answer_rejected`. Absent uses the kernel's default.
	 */
	readonly maxAnswerReviews?: number
	/**
	 * Isolation for the commands this session runs. Absent means ON with
	 * the platform's defaults.
	 *
	 * Absent used to mean the opposite, and not by decision: nothing in
	 * this package ever built a provider, so `context.sandbox` was always
	 * undefined and every command ran in this process with this
	 * environment.
	 */
	readonly sandbox?: SandboxConfig
	/** See `NamzuCliConfig.web`. Absent means no web tool and no provider. */
	readonly web?: WebConfig
	/**
	 * Mount `ask_user_question`. Only where somebody can answer: an
	 * interactive terminal says `true`; a headless run leaves it absent, so
	 * the model is never offered a question it would ask into the void.
	 */
	readonly askUser?: boolean
	/** See `NamzuCliConfig.hooks`. Attached to the plugin lifecycle manager. */
	readonly hooks?: HooksConfig
	/** See `NamzuCliConfig.compaction`. Absent means the kernel's structured strategy. */
	readonly compaction?: CompactionCliConfig
	/**
	 * Where this session's run events are recorded, if anywhere.
	 *
	 * A listener rather than a config: the CLI resolves `@namzu/telemetry`,
	 * builds the sink and the redaction chain, and hands the result here
	 * already assembled — so this file has no opinion about optional
	 * packages, redactors, or what a destination is.
	 */
	readonly onRunEvent?: (event: RunEvent) => void
	/** Durable goal authority for the main TUI session; omitted on headless surfaces. */
	readonly sessionGoals?: SessionGoalStore
	/**
	 * Mount host desktop control for a surface that owns an interactive
	 * permission callback. False by default: `run`, `run-stream` and `drain`
	 * have no human prompt to guard pointer/keyboard input and must not inherit
	 * this capability merely because the package is installed.
	 */
	readonly enableComputerUse?: boolean
}

export async function createAgentSession(
	prefs: Preferences,
	detected: readonly DetectedProvider[],
	options: AgentSessionOptions = {},
): Promise<AgentSession> {
	const scope = options.scope ?? mintScope()
	const requestedCwd = resolve(options.cwd ?? process.cwd())
	let cwd: string
	try {
		const entry = await stat(requestedCwd)
		if (!entry.isDirectory()) {
			return emptySession(`Working directory is not a directory: ${requestedCwd}`, 'invocation')
		}
		cwd = await realpath(requestedCwd)
	} catch (error) {
		return emptySession(
			`Working directory is unavailable: ${requestedCwd} — ${describeError(error)}`,
			'invocation',
		)
	}
	const sandboxWorkspace = options.sandbox?.workspace ?? 'working-directory'
	if (
		options.sandbox?.enabled !== false &&
		sandboxWorkspace === 'working-directory' &&
		cwd === parse(cwd).root
	) {
		return emptySession(
			`Working-directory sandboxing refuses filesystem root ${cwd}; choose a project directory so confinement has a boundary, or explicitly select an ephemeral workspace.`,
			'invocation',
		)
	}
	const hierarchyRoot = resolve(options.stateRoot ?? join(cwd, '.namzu'))
	const pathBuilder = new DefaultPathBuilder(hierarchyRoot)
	let projectStateRoot = hierarchyRoot
	try {
		if (options.stateRoot) {
			const projectsRoot = ensurePrivateStateDirectory(hierarchyRoot, 'projects')
			projectStateRoot = ensurePrivateStateDirectory(projectsRoot, scope.projectId)
		}
		// Refuse an aliased or otherwise unsafe generated-state root before any
		// provider, sandbox or plugin runtime is constructed. Project-authored
		// `.namzu` content may coexist here, but generated memory must never be
		// redirected outside the trusted working directory through an ancestor
		// symlink.
		ensurePrivateStateDirectory(projectStateRoot, 'memory')
	} catch (error) {
		return emptySession(`Project state is unavailable: ${describeError(error)}`, 'environment')
	}
	// The head serves; the tail is fallen over to, in order, when it cannot.
	const primary = primaryProvider(prefs)
	const entry = PROVIDER_REGISTRY[primary.id]
	if (!entry) {
		// The one failure on this path that whoever asked can fix by asking for
		// something else: `--provider` is a flag, and this id is not a provider.
		// Every other refusal below is about the machine.
		return emptySession(`Unknown provider "${primary.id}" — pick another.`, 'invocation')
	}
	const det = findDetected(detected, primary.id)
	if (entry.requiresApiKey && (!det || !det.apiKey)) {
		// The BACKSTOP, not the operator-facing answer. The TUI never reaches this
		// line any more: `probeAgentSession` reports the same gap as a
		// `credentialGap` and the App routes into the picker, where a credential
		// can actually be entered. What still arrives here is a headless caller —
		// `run`, `run-stream`, `drain` — which has no picker and for which both
		// pieces of advice below are real: an environment variable, or
		// `--provider`. Keeping the refusal is what makes those runs fail rather
		// than quietly start on something else.
		return emptySession(
			`No credential found for ${entry.label}. Set one of: ${entry.envVars.join(', ')} — or pass --provider with one that is configured.`,
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
	// One line naming the head and how many declared fallbacks are usable —
	// `fallbackPlan.notices` already carries WHY each skipped member did (no
	// credential, unknown id, not registered); this promotes that same
	// information from a UI notice string to a boot record rather than
	// computing it a second time.
	cliLogger().info('provider chain resolved', {
		[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.PROVIDER_RESOLVED,
		'gen_ai.request.model': model,
		'namzu.provider.id': primary.id,
		'namzu.provider.chain_length': prefs.providers.length,
		'namzu.provider.skipped_count': fallbackPlan.notices.length,
	})
	for (const notice of fallbackPlan.notices) {
		cliLogger().warn(notice, {
			[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.PROVIDER_RESOLVED,
		})
	}
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
	// we re-read the credential store (another process may have rotated it) and
	// refresh a stale token, rebuilding the client only when the token actually
	// changed. Gated on `det.oauth` so env / secrets credentials are never
	// touched.
	//
	// `origin` decides WHICH publication rule applies, and travels with the
	// credential from discovery rather than being assumed here: namzu's own
	// store can be conditionally replaced; the owner's rotating grant is published
	// back to its exact owner file; the borrowed Keychain entry remains read-only.
	const subscriptionRefresh =
		primary.id === 'anthropic' &&
		(det?.oauth?.origin === 'stored' || det?.oauth?.origin === 'claude-file')
	const borrowedAnthropic = primary.id === 'anthropic' && det?.oauth?.origin === 'keychain'
	const borrowedCodexPath =
		primary.id === 'codex' && det?.source.kind === 'codex-file' ? det.source.path : undefined
	const storedCodex = primary.id === 'codex' && det?.codex?.origin === 'stored'
	const credentialOrigin = det?.oauth?.origin ?? 'keychain'
	const credentialPath = det?.oauth?.sourcePath
	let currentToken = det?.apiKey
	let currentCodexAccount = det?.codex?.accountId
	let credentialTail: Promise<void> = Promise.resolve()
	let rejectedRefresh:
		| {
				readonly credential: AgentOAuthCredential
				readonly error: CredentialRefreshRejectedError
		  }
		| undefined
	const performRefresh = async (signal?: AbortSignal): Promise<void> => {
		signal?.throwIfAborted()
		// Read only after this owner reaches the head. A sibling may have rotated
		// the durable credential while we waited; reading before the queue would
		// make its success invisible and permit a stale-token downgrade.
		const cred = readSubscriptionCredential(credentialOrigin, credentialPath)
		// This store is the authority for the whole session. Its absence is a
		// credential withdrawal, not permission to keep using the client object
		// that happens to remain in memory after logout or another process's clear.
		if (!cred) throw new CredentialWithdrawnError()
		if (rejectedRefresh && sameOAuthCredential(rejectedRefresh.credential, cred)) {
			throw rejectedRefresh.error
		}
		// A different non-null credential is an external winner (usually a fresh
		// login). The old grant's refusal says nothing about this one.
		rejectedRefresh = undefined
		let fresh: string
		try {
			fresh = await ensureFreshAnthropicToken(
				cred.accessToken,
				{
					refreshToken: cred.refreshToken,
					expiresAt: cred.expiresAt,
					scopes: cred.scopes,
					origin: credentialOrigin,
					sourcePath: credentialPath,
				},
				signal,
			)
		} catch (error) {
			if (error instanceof CredentialRefreshRejectedError) {
				// Cache only if the same credential is still authoritative after the
				// network wait. A concurrent login must not inherit the old grant's
				// permanent classification.
				signal?.throwIfAborted()
				const current = readSubscriptionCredential(credentialOrigin, credentialPath)
				if (!current) throw new CredentialWithdrawnError()
				if (sameOAuthCredential(current, cred)) {
					rejectedRefresh = { credential: cred, error }
				}
			}
			throw error
		}
		signal?.throwIfAborted()
		if (fresh === currentToken) return
		try {
			const refreshedProvider = constructProvider(
				'anthropic',
				{ ...(det as DetectedProvider), apiKey: fresh },
				model,
			)
			// Publish the pair together. If construction fails, both old values
			// remain live and the next operation can retry against the stored token.
			provider = refreshedProvider
			currentToken = fresh
		} catch (err) {
			// Keep the previous client; the turn may still 401 but won't crash.
			// Silent until now — a client rebuild failing after a token refresh
			// had no trace anywhere, so the first sign of it was a live 401 an
			// operator had no way to connect back to "the refresh happened, the
			// rebuild didn't."
			cliLogger().warn(
				'provider client rebuild after token refresh failed',
				exceptionAttributes(err),
			)
		}
	}
	const rereadBorrowedCodex = (signal?: AbortSignal): void => {
		signal?.throwIfAborted()
		if (!borrowedCodexPath) return
		const credential = readCodexCredentialFile(borrowedCodexPath)
		if (!credential) {
			throw new CredentialWithdrawnError(
				'The Codex session Namzu borrowed is no longer available. Run `codex login` or choose another provider.',
			)
		}
		if (credential.expiresAt !== undefined && credential.expiresAt - Date.now() <= 60_000) {
			throw new CredentialWithdrawnError(
				'The Codex session on this device has expired. Run `codex login` to let its owner refresh the session, then retry in Namzu.',
			)
		}
		if (credential.accessToken === currentToken && credential.accountId === currentCodexAccount) {
			return
		}
		const refreshedProvider = constructProvider(
			'codex',
			{
				...(det as DetectedProvider),
				apiKey: credential.accessToken,
				codex: {
					accountId: credential.accountId,
					expiresAt: credential.expiresAt,
					origin: 'codex-file',
				},
			},
			model,
		)
		provider = refreshedProvider
		currentToken = credential.accessToken
		currentCodexAccount = credential.accountId
	}
	const rereadBorrowedAnthropic = (signal?: AbortSignal): void => {
		signal?.throwIfAborted()
		if (!borrowedAnthropic) return
		const credential = readSubscriptionCredential(credentialOrigin, credentialPath)
		if (!credential) {
			throw new CredentialWithdrawnError(
				'The Claude session Namzu borrowed is no longer available. Run `claude login` or choose another provider.',
			)
		}
		if (credential.expiresAt !== undefined && credential.expiresAt - Date.now() <= 60_000) {
			throw new CredentialWithdrawnError(
				'The Claude session on this device has expired. Run `claude login` to let its owner refresh the session, then retry in Namzu.',
			)
		}
		if (credential.accessToken === currentToken) return
		provider = constructProvider(
			'anthropic',
			{ ...(det as DetectedProvider), apiKey: credential.accessToken },
			model,
		)
		currentToken = credential.accessToken
	}
	const refreshStoredCodex = async (signal?: AbortSignal): Promise<void> => {
		const credential = await ensureFreshStoredCodexCredential(signal)
		if (credential.accessToken === currentToken && credential.accountId === currentCodexAccount) {
			return
		}
		const refreshedProvider = constructProvider(
			'codex',
			{
				...(det as DetectedProvider),
				apiKey: credential.accessToken,
				codex: {
					accountId: credential.accountId,
					expiresAt: credential.expiresAt,
					origin: 'stored',
				},
			},
			model,
		)
		provider = refreshedProvider
		currentToken = credential.accessToken
		currentCodexAccount = credential.accountId
	}
	const prepareProviderCredential = (signal?: AbortSignal): Promise<void> => {
		if (!subscriptionRefresh && !borrowedAnthropic && !borrowedCodexPath && !storedCodex) {
			signal?.throwIfAborted()
			return Promise.resolve()
		}
		signal?.throwIfAborted()
		const queued = credentialTail.then(async () => {
			if (subscriptionRefresh) await performRefresh(signal)
			else if (borrowedAnthropic) rereadBorrowedAnthropic(signal)
			else if (storedCodex) await refreshStoredCodex(signal)
			else rereadBorrowedCodex(signal)
		})
		// Keep later owners behind this slot even if its caller stops observing it.
		// The catch makes the private tail non-rejecting without changing the
		// exact outcome returned to the owner below.
		credentialTail = queued.catch(() => {})
		return signal ? observeWithSignal(queued, signal) : queued
	}
	// Session-owned discovery with one drain cursor per run. A child shares the
	// discovered scopes without being able to consume the parent's update, and
	// an edit takes effect in this session rather than only after reconnecting.
	const projectInstructions = new ProjectInstructionTracker(cwd)
	// Before the registry, because a `requireIsolation` this machine cannot
	// meet throws here — and failing before the session is built is the
	// difference between "namzu refused to start" and a half-constructed
	// session reporting a tool error on the first command. Ordering is load
	// bearing on BOTH sides of this block: `resolveSandbox` stays BEFORE
	// `buildToolRegistry` below (unchanged), and the emit two statements down
	// stays strictly AFTER `resolveSandbox` returns — logging "attempting to
	// resolve the sandbox" ahead of the call would say nothing `resolveSandbox`
	// itself doesn't already say better, for a narrative that is supposed to
	// report facts, not attempts.
	let sandbox: ResolvedSandbox
	try {
		sandbox = resolveSandbox(cliLogger(), options.sandbox)
	} catch (err) {
		// The one refusal in this function that does not go through
		// `emptySession(...)`: `resolveSandbox` THROWS rather than degrading
		// when `sandbox.requireIsolation` names a control this host cannot
		// meet (see that function's own doc comment), and a caller half-built
		// at that point has nothing to return a session FROM. Logged here,
		// then re-thrown unchanged — `runCli`'s own top-level catch (already
		// in place, untouched by this change) is what turns the throw into a
		// non-zero exit; this is only responsible for the record existing
		// before that happens.
		cliLogger().error(err instanceof Error ? err.message : String(err), {
			[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.BOOT_REFUSED,
			'namzu.refusal.kind': 'environment',
		})
		throw err
	}
	// AFTER resolveSandbox returns — the honest report of what THIS run got,
	// never what was attempted. `unconfined` decides the severity: per the
	// design, this is "the single highest-value line in the whole design,
	// today computed and thrown away" — an operator reading default `info`
	// output must see it specifically when nothing is enforced, not only
	// under `--verbose`.
	cliLogger()[sandboxResolvedSeverity(sandbox)](sandbox.notice, {
		[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.SANDBOX_RESOLVED,
		'namzu.sandbox.unconfined': sandbox.unconfined,
	})
	const backgroundJobs = sandbox.provider === undefined
	const { registry, memoryStore } = buildToolRegistry(cwd, projectStateRoot, backgroundJobs)
	// Package presence is not tool reachability. The CLI used to probe and
	// report @namzu/computer-use without ever constructing its host or mounting
	// SDK's computer_use definition, so even an installed, healthy package was
	// invisible to the model. Probe first to retain absent/broken diagnostics;
	// only a successfully initialised adapter earns a schema in the registry.
	const capabilities = await probeCapabilities()
	const computerUsePackage = capabilities.find((probe) => probe.specifier === '@namzu/computer-use')
	let computerUseHost: SubprocessComputerUseHost | undefined
	let computerUseError: Error | undefined
	if (options.enableComputerUse === true && computerUsePackage?.state === 'present') {
		const candidate = new SubprocessComputerUseHost()
		try {
			await candidate.initialize()
			registry.register(createComputerUseTool(candidate))
			computerUseHost = candidate
		} catch (error) {
			computerUseError = error instanceof Error ? error : new Error(String(error))
			await candidate.dispose().catch(() => {})
		}
	}
	// Registered only on the main session path. Sub-agents call
	// `buildToolRegistry` directly below, so they never receive these tools.
	// Per-send denial further keeps the schemas out of ordinary human turns.
	const goalAuthorities = new Map<RunId, GoalRoundAuthority>()
	// A child is created after the parent query has started, from inside its
	// Agent tool. Keying the review channel by the executing run keeps two
	// concurrent sends from borrowing each other's prompt or approval latch.
	const delegatedResumeHandlers = new Map<RunId, ResumeHandler>()
	const goalToolNames = new Set<string>(SESSION_GOAL_TOOL_NAMES)
	if (options.sessionGoals) {
		registry.register(
			buildSessionGoalTools(options.sessionGoals, (runId) => goalAuthorities.get(runId)),
		)
	}
	// External tool servers, before the roster is counted, so `toolNames` and
	// the `/tools` list a user reads include what they configured. Connecting
	// after the count would report a session smaller than the one that runs.
	const mcp = await connectMcpServers(options.mcpServers, { cwd })
	if (mcp.tools.length > 0) registry.register([...mcp.tools])
	// External connector discovery is reported separately from executable
	// plugin discovery. Folding both counts together would make a failed server
	// indistinguishable from a plugin that never enabled.
	cliLogger().info('discovery complete', {
		[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.DISCOVERY_COMPLETED,
		'namzu.discovery.kind': 'connector',
		'namzu.discovery.count': mcp.connected.length,
		'namzu.discovery.tool_count': mcp.tools.length,
		'namzu.discovery.failed_count': mcp.failed.length,
	})
	for (const server of mcp.connected) {
		cliLogger().debug('connector discovered', {
			[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.DISCOVERY_COMPLETED,
			'namzu.discovery.kind': 'connector',
			'namzu.connector.name': server.name,
			'namzu.connector.tool_count': server.toolCount,
		})
	}
	for (const server of mcp.failed) {
		cliLogger().debug('connector failed to connect', {
			[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.DISCOVERY_COMPLETED,
			'namzu.discovery.kind': 'connector',
			'namzu.connector.name': server.name,
		})
	}
	// Detected once per session, not per capability check an operator might
	// separately run via `namzu doctor`. Package probes still supply optional
	// package details; the aggregate overrides capabilities whose runtime
	// admission has a more authoritative answer.
	logCapabilities(capabilities, {
		sandboxReady: sandbox.provider !== undefined,
		computerUseReady: computerUseHost !== undefined,
		...(computerUseError ? { computerUseError } : {}),
	})
	// This session passes a `taskStore` to query() below, which registers the
	// task tools deferred — so `search_tools` has something to find here.
	registry.register([SearchToolsTool])
	// Web reach, opted into in the config file and nowhere else. The parent's
	// registry only: a child's config carries no provider, and a tool whose
	// provider is missing is a tool that reports itself unwired — truthful,
	// and noise. The guarded provider refuses private and loopback addresses
	// and bounds redirects and body; every fetch is reviewed like a shell
	// command (see `isPromptExempt`).
	const webCapability = options.web?.fetch ? { fetch: new GuardedFetchProvider() } : undefined
	if (webCapability) registry.register(WebFetchTool)
	// Native sub-agents: register the canonical `Agent` tool so the model can
	// delegate a self-contained task to a fresh sub-agent (own context window).
	// Best-effort — if the runtime can't stand up, the chat still works.
	let subagentGateway: TaskScheduler | undefined
	let subagentRuntime: SubagentRuntime | undefined
	// Stays empty when the runtime below throws, which is the honest answer: the
	// catch is non-fatal and the session then genuinely has no delegate to
	// dispatch to. A roster reported from the request rather than the result
	// would name agents that are not there.
	let allowedAgentIds: readonly string[] = []
	try {
		// Agents the project or user defined in files. A file that cannot be
		// loaded is named with its reason rather than silently absent: "namzu
		// ignored my reviewer" and "namzu never saw it" call for opposite fixes.
		const discovered = await discoverAgentDefinitions({ cwd })
		for (const skipped of discovered.skipped) {
			cliLogger().warn('agent definition skipped', {
				'namzu.agent.definition.path': skipped.path,
				'namzu.agent.definition.reason': skipped.reason,
			})
		}
		const sub = await createSubagentRuntime({
			cwd,
			model,
			definitions: discovered.definitions,
			pathBuilder: new DefaultPathBuilder(join(projectStateRoot, 'subagents')),
			sandboxWorkspace,
			resolveResumeHandler: (runId) => delegatedResumeHandlers.get(runId),
			...(sandbox.provider ? { sandboxProvider: sandbox.provider } : {}),
			...(options.sandbox?.teardownTimeoutMs !== undefined
				? { sandboxTeardownTimeoutMs: options.sandbox.teardownTimeoutMs }
				: {}),
			// A sub-agent works in the same repository and writes the same code,
			// so it is bound by the same instructions. Without this the parent
			// honours the project's rules and every task it delegates quietly
			// does not — the worse half of the feature, because the delegating
			// turn reports success either way.
			projectInstructionContext: () => projectInstructions.createRunContext(),
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
				//
				// The store this also builds is dropped, deliberately: a sub-agent
				// promoting its own run memory would write a record per
				// delegation, and a parent that delegated six times would leave
				// seven accounts of one piece of work for the next run to read.
				// The parent's settle is the one that speaks for the whole task.
				return buildToolRegistry(cwd, projectStateRoot, backgroundJobs).registry
			},
			authorizationGate: gateFor(options.rules),
		})
		subagentRuntime = sub
		registry.register([sub.agentTool])
		subagentGateway = sub.gateway
		allowedAgentIds = sub.allowedAgentIds
	} catch (err) {
		await subagentRuntime?.close().catch((closeError: unknown) => {
			cliLogger().warn(
				'sub-agent runtime cleanup failed after admission refusal',
				exceptionAttributes(closeError),
			)
		})
		subagentRuntime = undefined
		// Sub-agents unavailable this session — non-fatal: `allowedAgentIds`
		// stays empty and the chat still works. Silent until now, which was
		// the wrong kind of non-fatal — an operator who expected delegation
		// and got none had nothing on stderr to say why.
		cliLogger().warn('sub-agent runtime unavailable this session', exceptionAttributes(err))
	}
	// `ask_user_question`, where somebody can answer. The SDK tool parks the
	// run through the handler it was BUILT with, so that handler reads the
	// turn's answerer through a holder the prelude fills: the tool is per
	// session, the person answering is per turn. Needs the delegation
	// gateway the tool builder requires; a session without one has no
	// question tool either, and says nothing — it also has no `Agent`.
	let currentOnQuestion: QuestionFn | undefined
	if (options.askUser && subagentGateway) {
		const parkQuestion: ResumeHandler = async (request) => {
			if (request.type !== 'user_question') return { action: 'continue' }
			const ask = currentOnQuestion
			if (!ask) return { action: 'continue' }
			const answer = await ask(request.question)
			switch (answer.kind) {
				case 'answer':
					return {
						action: 'answer_question',
						selectedOptionIds: [...answer.selectedOptionIds],
						...(answer.freeText !== undefined ? { freeText: answer.freeText } : {}),
						questionId: request.question.questionId,
					}
				case 'abort':
					return { action: 'abort', reason: 'The user declined to answer.' }
				default:
					return { action: 'continue' }
			}
		}
		// The park request carries the run id of the call that asked; the
		// handler above routes by the question, not by the run, and no durable
		// park recorder is supplied.
		registry.register(buildAskUserQuestionTool({ resumeHandler: parkQuestion }))
	}
	// Task store → query registers task_create / task_update / task_list and
	// emits task_created/task_updated, so the agent can track a plan for the
	// current request. Tasks are run-scoped. The kernel's default availability
	// for them is `deferred`; this session overrides that to `active` at the
	// query call, because the doctrine tells the model to plan with them and a
	// tool it must search for first is a tool it skips.
	//
	// `search_tools` stays mounted above even so: a tool server or plugin can
	// still register a deferred roster, and that is what the search is for. The
	// task tools are registered inside query(), after this function returns,
	// which is why the connect line reports no count of them — counting here
	// would mean restating query's registration order in the CLI.
	//
	// It is also why `toolNames` below reads the registry rather than a list
	// captured on this line. The count at connect time is unchanged; what
	// changes is that asking again later gets a later answer.
	ensurePrivateStateDirectory(projectStateRoot, 'tenants')
	const taskStore: TaskStore = new DiskTaskStore({
		baseDir: projectStateRoot,
		defaultRunId: asRunId('run_namzu-cli'),
		tenantId: scope.tenantId,
	})
	// Persists across turns: once the user picks "approve all", later tool
	// batches in this session run without prompting.
	const approval = { all: false }
	// What a settled run leaves behind, over the SAME store `search_memory`
	// reads on the next run. Built once per session rather than per turn: it
	// holds no per-run state, and a per-turn construction would re-open the
	// index for every message.
	//
	// Unconditional, unlike the answer gate. A gate changes what a run may do
	// and so must be asked for; promotion changes only what survives it, and
	// the alternative — the run's own extracted knowledge being discarded at
	// settle — is what this repository has been doing all along by accident.
	// A run that learned nothing still writes nothing.
	const promoteMemory = createMemoryPromoter({ store: memoryStore })
	// Plugins are the last fallible startup resource. The ordering is ownership:
	// a malformed MCP entry cannot strand imported plugin hooks, and a plugin
	// refusal closes the MCP processes already opened for this candidate before
	// returning an inert session. Sub-agents were built above from their own
	// registries, so executable plugins remain a top-level-session capability.
	let pluginRuntime: Awaited<ReturnType<typeof createCliPluginRuntime>>
	try {
		pluginRuntime = await createCliPluginRuntime(options.plugins, registry, cwd, options.hooks)
	} catch (error) {
		await Promise.allSettled([mcp.close(), computerUseHost?.dispose()])
		return emptySession(describeError(error))
	}
	if (pluginRuntime) {
		cliLogger().info('discovery complete', {
			[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.DISCOVERY_COMPLETED,
			'namzu.discovery.kind': 'plugin',
			'namzu.discovery.count': pluginRuntime.pluginCount,
			'namzu.discovery.skill_count': pluginRuntime.skills.size,
		})
	}
	// The one terminal POSITIVE event on this path, emitted exactly once —
	// every early return above goes through `emptySession`, which emits
	// `namzu.boot.refused` instead, and the `resolveSandbox` throw path above
	// emits its own `boot.refused` and never reaches this line at all. No
	// boolean readiness field anywhere in the record: systemd's own `READY=1`
	// has no `READY=0` counterpart, for the same reason — a field that CAN
	// say "not ready" is a field some unaudited path can wrongly set true.
	cliLogger().info('agent session ready', {
		[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.BOOT_READY,
	})
	const operations = new SessionOperationOwner(async () => {
		const results = await Promise.allSettled([
			subagentRuntime?.close?.(),
			pluginRuntime?.close(),
			mcp.close(),
			computerUseHost?.dispose(),
		])
		const failures = results
			.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
			.map((result) => result.reason)
		if (failures.length > 0) throw new AggregateError(failures, 'Session cleanup failed.')
	})
	let reasoningEffortLevels: readonly ReasoningEffort[] | undefined
	let reasoningEffortDefault: ReasoningEffort | undefined
	let effortNotice: string | undefined
	try {
		const capabilityView = withProviderFallback([
			{ provider, model },
			...fallbackPlan.build(currentToken),
		])
		const offered = capabilityView.reasoningEffortLevelsFor
			? capabilityView.reasoningEffortLevelsFor(model)
			: capabilityView.effortLevelsFor?.(model)
		reasoningEffortLevels = offered === undefined ? undefined : Object.freeze([...offered])
		try {
			const publishedDefault = capabilityView.reasoningEffortDefaultFor?.(model)
			if (
				publishedDefault !== undefined &&
				reasoningEffortLevels !== undefined &&
				!reasoningEffortLevels.includes(publishedDefault)
			) {
				effortNotice = `The provider published default effort "${publishedDefault}" outside its exact menu. Directional effort shortcuts require an explicit selection.`
			} else {
				reasoningEffortDefault = publishedDefault
			}
		} catch (error) {
			effortNotice = `The default reasoning effort could not be established for this session: ${describeError(error)}`
		}
	} catch (error) {
		reasoningEffortLevels = undefined
		reasoningEffortDefault = undefined
		effortNotice = `Reasoning effort levels could not be established for this session: ${describeError(error)}`
	}
	return {
		hasProvider: true,
		sandbox: {
			unconfined: sandbox.unconfined,
			...(sandbox.environment ? { environment: sandbox.environment } : {}),
			enforced: sandbox.enforced,
			required: sandbox.required,
			workspace: sandbox.workspace,
		},
		providerSummary: entry.label,
		modelSummary: model,
		reasoningEffortLevels,
		reasoningEffortDefault,
		compact: (messages) =>
			operations.promise(undefined, async (signal) => {
				await prepareProviderCredential(signal)
				return compactNow({
					messages,
					config: compactionConfigFor(options.compaction),
					provider,
					model,
					signal,
				})
			}),
		// Reads the same registry object the deferred registration mutates, at
		// call time — the pair of `promptExemptTools` below, and for the same
		// reason.
		toolNames: () =>
			registry
				.getCallableTools()
				.map((t) => t.name)
				.filter((name) => !goalToolNames.has(name)),
		agentIds: allowedAgentIds,
		...(subagentRuntime ? { subagents: subagentRuntime.activity } : {}),
		get instructionFiles() {
			return projectInstructions.instructionFiles
		},
		get skippedInstructionFiles() {
			return projectInstructions.skippedInstructionFiles
		},
		get mcpConnected() {
			return mcp.connected
		},
		get mcpFailed() {
			return mcp.failed
		},
		mcpStatus: () => mcp.current(),
		configNotices: [
			...(capabilityNotice ? [capabilityNotice] : []),
			...(effortNotice ? [effortNotice] : []),
			...(computerUseError
				? [`Computer use is unavailable on this device: ${describeError(computerUseError)}`]
				: []),
			...unresolvedNotice.map(
				(line) => `Provider chain: capabilities could not be established for ${line}.`,
			),
			...fallbackPlan.notices,
		],
		close: () => operations.close(),
		errorHint: null,
		errorKind: null,
		// Reads the same object the handler mutates, at call time.
		approvalLatched: () => approval.all,
		resetApprovalLatch: () => {
			approval.all = false
		},
		promptExemptTools: () =>
			promptExemptToolNames(registry).filter((name) => !goalToolNames.has(name)),
		send: (messages, opts) =>
			operations.stream(opts?.signal, (signal) =>
				(async function* () {
					const runId = opts?.runId ?? generateRunId()
					const turnOpts: SendOptions = { ...opts, runId, signal }
					const resumeHandler = makeResumeHandler(
						approval,
						opts?.onPermission,
						opts?.permissionMode ?? options.permissionMode,
						(name, input) => isPromptExempt(registry, name, input),
					)
					if (delegatedResumeHandlers.has(runId)) {
						throw new Error(`Run ${runId} already owns a delegated review channel.`)
					}
					delegatedResumeHandlers.set(runId, resumeHandler)
					try {
						// Renew a lapsed OAuth token before the turn runs (no-op for valid
						// tokens and non-subscription credentials).
						await prepareProviderCredential(signal)
						// namzu identity first (so it establishes who the agent is even when
						// the credential layer prepends whatever prefix its token requires),
						// then memory and per-turn extra context. Project instructions are a
						// separate retained user-context snapshot prepared by the controller;
						// that is what lets nested scopes be replaced and persisted safely.
						//
						// The environment block is read fresh every turn because both facts in it
						// can change WHILE the session
						// runs — midnight passes, and the agent checks out a branch itself.
						// Its text only changes when a fact changes, so it costs a prompt-cache
						// miss exactly when a hit would have been a stale claim.
						const pluginSkills = pluginRuntime
							? await currentPluginSkills(pluginRuntime.skills)
							: undefined
						const memoryPrompt = composeMemoryPrompt(readMemory())
						currentOnQuestion = opts?.onQuestion
						const [environmentFacts, turnSnapshot] = await Promise.all([
							readEnvironmentFacts(cwd),
							readTurnSnapshot(cwd),
						])
						const environmentPrompt = composeEnvironmentPrompt(environmentFacts)
						// The repository as it stood when THIS turn began, through the
						// SDK's `turn` placement — the ephemeral trailing message that is
						// never cached and never enters history. FIRST iteration only:
						// later iterations work from state the model itself changed, and
						// `git status` is the honest source for that. A registry per
						// turn, closed over this turn's snapshot, rather than one
						// session-scoped holder every send overwrites: two overlapping
						// sends would otherwise both render whichever ran second.
						const turnSnapshotPrompt = turnSnapshot ? composeTurnSnapshot(turnSnapshot) : null
						const promptContributions = new PromptContributionRegistry()
						promptContributions.register({
							id: 'namzu.turn-snapshot',
							placement: 'turn',
							render: ({ iteration }) => (iteration === 1 ? turnSnapshotPrompt : null),
						})
						// The citation rules that come with the web tools, only when the
						// tools are there: guidance about a capability the turn does not
						// have reads as a capability it should be looking for.
						if (webCapability) promptContributions.register(webGuidanceContribution)
						const systemPrompt =
							[
								NAMZU_IDENTITY,
								NAMZU_WORKING_DOCTRINE,
								NAMZU_DELEGATION_DOCTRINE,
								// Present only while the turn runs under `plan`. A mode change
								// is rare, so the cached prefix it re-keys is a price paid once
								// per switch rather than once per turn.
								opts?.permissionMode === 'plan' ? NAMZU_PLAN_MODE_DOCTRINE : undefined,
								environmentPrompt,
								memoryPrompt,
								opts?.extraSystem,
							]
								.filter((s): s is string => Boolean(s))
								.join('\n\n') || undefined
						let capturedAuthority: GoalRoundAuthority | undefined
						if (opts?.goalRound) {
							if (!opts.runId) throw new Error('A goal round requires a caller-reserved runId.')
							if (!options.sessionGoals) throw new Error('This session has no durable goal store.')
							if (
								opts.goalRound.sessionId !== scope.sessionId ||
								opts.goalRound.tenantId !== scope.tenantId
							) {
								throw new Error('Goal-round authority does not belong to this agent session scope.')
							}
							const current = await options.sessionGoals.getGoal(scope.sessionId, scope.tenantId)
							if (
								!current ||
								current.phase !== 'active' ||
								current.id !== opts.goalRound.id ||
								current.revision !== opts.goalRound.revision ||
								current.objective !== opts.goalRound.objective ||
								current.roundsAdmitted !== opts.goalRound.round ||
								current.maxGoalRounds !== opts.goalRound.maxGoalRounds
							) {
								throw new Error('Goal-round authority is stale or does not match the durable goal.')
							}
							if (goalAuthorities.has(opts.runId)) {
								throw new Error(`Run ${opts.runId} already owns goal-round authority.`)
							}
							capturedAuthority = Object.freeze({ ...opts.goalRound })
							goalAuthorities.set(opts.runId, capturedAuthority)
						}
						try {
							yield* runTurn({
								provider,
								compactionConfig: compactionConfigFor(options.compaction),
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
								pluginManager: pluginRuntime?.manager,
								skillRegistry: pluginRuntime?.skills,
								skills: pluginSkills,
								scope,
								pathBuilder,
								workingDirectory: cwd,
								sandboxWorkspace,
								rules: options.rules,
								reviewAnswer: options.reviewAnswer,
								maxAnswerReviews: options.maxAnswerReviews,
								promoteMemory,
								taskStore,
								systemPrompt,
								messages,
								projectInstructionContext: projectInstructions.createRunContext(),
								opts: turnOpts,
								resumeHandler,
								taskGateway: subagentGateway,
								promptContributions,
								...(webCapability ? { web: webCapability } : {}),
								// Active, not deferred: the doctrine tells the model to open a
								// task list for multi-step work, and a tool it has to search
								// for first is a tool it will skip.
								runtimeToolOverrides: {
									task_create: 'active',
									task_update: 'active',
									task_list: 'active',
								},
								onRunEvent: options.onRunEvent,
								...(sandbox.provider ? { sandboxProvider: sandbox.provider } : {}),
								...(options.sandbox?.teardownTimeoutMs !== undefined
									? {
											sandboxTeardownTimeoutMs: options.sandbox.teardownTimeoutMs,
										}
									: {}),
							})
						} finally {
							if (
								opts?.runId &&
								capturedAuthority &&
								goalAuthorities.get(opts.runId) === capturedAuthority
							) {
								goalAuthorities.delete(opts.runId)
							}
						}
					} finally {
						if (delegatedResumeHandlers.get(runId) === resumeHandler) {
							delegatedResumeHandlers.delete(runId)
						}
					}
				})(),
			),
		resumeDurable: ({ entry, checkpointStore, claimFence, signal }) =>
			operations.promise(signal, async (ownedSignal) => {
				// The same prelude a turn runs, and for the same reasons: a lapsed
				// OAuth token has to be renewed before the provider is used, and the
				// fallback chain has to be built AFTER that so its members do not
				// hold a client the refresh just replaced.
				await prepareProviderCredential(ownedSignal)
				const pluginSkills = pluginRuntime
					? await currentPluginSkills(pluginRuntime.skills)
					: undefined
				const memoryPrompt = composeMemoryPrompt(readMemory())
				const environmentPrompt = composeEnvironmentPrompt(await readEnvironmentFacts(cwd))
				const systemPrompt =
					[
						NAMZU_IDENTITY,
						NAMZU_WORKING_DOCTRINE,
						NAMZU_DELEGATION_DOCTRINE,
						environmentPrompt,
						memoryPrompt,
					]
						.filter((s): s is string => Boolean(s))
						.join('\n\n') || undefined

				const resumeHandler = makeResumeHandler(
					approval,
					undefined,
					options.permissionMode,
					(name, input) => isPromptExempt(registry, name, input),
				)
				if (delegatedResumeHandlers.has(entry.runId)) {
					throw new Error(`Run ${entry.runId} already owns a delegated review channel.`)
				}
				delegatedResumeHandlers.set(entry.runId, resumeHandler)
				try {
					return await resumeRun({
						provider,
						fallbackProviders: fallbackPlan.build(currentToken),
						tools: registry,
						pluginManager: pluginRuntime?.manager,
						skillRegistry: pluginRuntime?.skills,
						skills: pluginSkills,
						taskStore,
						// The same availability the original run registered under.
						// A resumed run re-registers the task tools; leaving them at
						// the kernel's `deferred` default would hand the model a plan
						// it started with active tools and can no longer update.
						runtimeToolOverrides: {
							task_create: 'active',
							task_update: 'active',
							task_list: 'active',
						},
						...(subagentGateway ? { taskGateway: subagentGateway } : {}),
						authorizationGate: gateFor(options.rules),
						compactionConfig: compactionConfigFor(options.compaction),
						projectInstructionContext: projectInstructions.createRunContext(),
						pathBuilder,
						...(sandbox.provider ? { sandboxProvider: sandbox.provider } : {}),
						...(options.sandbox?.teardownTimeoutMs !== undefined
							? { sandboxTeardownTimeoutMs: options.sandbox.teardownTimeoutMs }
							: {}),
						// NOT `emergencySave`, unlike a turn. The manager is a singleton
						// whose `attach` detaches whoever held it before, so a caller
						// resuming several runs in one process would leave only the last
						// one covered — and would look covered. A turn owns its process
						// end to end; a drainer does not.
						runConfig: {
							model,
							...(sandbox.provider ? { sandbox: { workspace: sandboxWorkspace } } : {}),
							timeoutMs: CLI_INTERACTIVE_RUN_TIMEOUT_MS,
							tokenBudget: 1_000_000,
							maxIterations: 50,
							maxResponseTokens: 8192,
							permissionMode: 'auto',
						},
						agentId: 'namzu',
						agentName: 'namzu',
						...(systemPrompt ? { systemPrompt } : {}),
						workingDirectory: cwd,
						// No `onPermission`: there is nobody at a drainer's terminal, so a
						// prompt would block the pass forever on a run nobody is watching.
						// The gate's deny rules still apply.
						// One presenter for the whole stream, built from the registry this
						// scope already holds. It was the absence of the registry HERE that
						// forced presentation to be name matching: `toAgentEvent` was pure
						// over a `RunEvent` and could not ask a tool anything.
						resumeHandler,
						signal: ownedSignal,
						// Attribution comes from the ENTRY, not from this session: the run
						// belongs to whoever started it, and stamping the drainer's ids onto
						// it would file another tenant's work under this one.
						tenantId: entry.tenantId,
						projectId: entry.projectId,
						sessionId: entry.sessionId,
						// …except the topic, which no checkpoint records — see
						// `RunStateScope`. This one is the drainer's, and honestly so:
						// supplied here rather than pretended to have been recovered.
						topicId: scope.topicId,
						scope: { ...entry, topicId: scope.topicId },
						checkpointStore,
						...(claimFence !== undefined ? { claimFence } : {}),
					})
				} finally {
					if (delegatedResumeHandlers.get(entry.runId) === resumeHandler) {
						delegatedResumeHandlers.delete(entry.runId)
					}
				}
			}),
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
	const usable: Array<{
		readonly choice: ProviderChoice
		readonly det: DetectedProvider | null
	}> = []

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

export function constructProvider(
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
		case 'codex': {
			if (!det?.codex?.accountId) {
				throw new Error(
					'Codex subscription credentials require ChatGPT account routing. Sign in with Codex again or choose the OpenAI API-key provider.',
				)
			}
			const { provider } = ProviderRegistry.create({
				type: 'codex',
				accessToken: det.apiKey ?? '',
				accountId: det.codex.accountId,
				baseURL: det.baseUrl,
				model,
			})
			return provider
		}
		case 'deepseek': {
			const { provider } = ProviderRegistry.create({
				type: 'deepseek',
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
	| {
			readonly kind: 'ok'
			readonly models: readonly Pick<ModelInfo, 'id' | 'name' | 'inputModalities'>[]
	  }
	/** The driver does not implement `listModels`. */
	| { readonly kind: 'unsupported' }
	| { readonly kind: 'timeout' }
	| { readonly kind: 'failed'; readonly reason: string }

const PICKER_PROVIDER_DEADLINE_MS = 3_000

class PickerProviderTimeoutError extends Error {
	constructor() {
		super(`The provider did not answer within ${PICKER_PROVIDER_DEADLINE_MS}ms.`)
		this.name = 'PickerProviderTimeoutError'
	}
}

/** Bound a picker side-call even when a third-party provider ignores abort. */
async function runPickerProviderOperation<T>(
	signal: AbortSignal | undefined,
	operation: (operationSignal: AbortSignal) => Promise<T>,
): Promise<T> {
	signal?.throwIfAborted()
	const controller = new AbortController()
	const timeoutCause = new PickerProviderTimeoutError()
	let rejectBoundary: (cause: unknown) => void = () => {}
	const boundary = new Promise<never>((_resolve, reject) => {
		rejectBoundary = reject
	})
	const onCallerAbort = () => {
		controller.abort(signal?.reason)
		rejectBoundary(signal?.reason)
	}
	signal?.addEventListener('abort', onCallerAbort, { once: true })
	const timer = setTimeout(() => {
		controller.abort(timeoutCause)
		rejectBoundary(timeoutCause)
	}, PICKER_PROVIDER_DEADLINE_MS)

	try {
		return await Promise.race([operation(controller.signal), boundary])
	} catch (error) {
		// Cooperative transports may replace the owner cause with AbortError.
		if (signal?.aborted) throw signal.reason
		if (controller.signal.aborted && controller.signal.reason === timeoutCause) throw timeoutCause
		throw error
	} finally {
		clearTimeout(timer)
		signal?.removeEventListener('abort', onCallerAbort)
	}
}

/**
 * Ask a detected provider what models it has.
 *
 * Instantiates the provider and calls its optional `listModels()`, inside a 3s
 * race so a wedged local server or a slow catalog cannot stall the UI.
 */
export async function describeProviderModels(
	id: ProviderId,
	det: DetectedProvider,
	signal?: AbortSignal,
): Promise<ModelListing> {
	try {
		signal?.throwIfAborted()
		// constructProvider calls ProviderRegistry.create, which throws
		// "Unsupported provider type" until the vendor package has registered
		// itself. The run path registers lazily via ensureRegistered; the
		// listing path must do the same or every provider returns nothing.
		await ensureRegistered(id)
		signal?.throwIfAborted()
		const provider = constructProvider(id, det, det.entry.defaultModel)
		if (typeof provider.listModels !== 'function') return { kind: 'unsupported' }

		const models = await runPickerProviderOperation(
			signal,
			(operationSignal) => provider.listModels?.(operationSignal) ?? Promise.resolve([]),
		)

		return {
			kind: 'ok',
			models: models.map((m) => ({
				id: m.id,
				name: m.name || m.id,
				...(m.inputModalities !== undefined ? { inputModalities: [...m.inputModalities] } : {}),
			})),
		}
	} catch (err) {
		if (signal?.aborted) throw signal.reason
		if (err instanceof PickerProviderTimeoutError) return { kind: 'timeout' }
		return {
			kind: 'failed',
			reason: err instanceof Error ? err.message : String(err),
		}
	}
}

/**
 * Check a key the operator just typed, without spending a turn.
 *
 * Uses the provider's declared `probeCredential` operation. A driver without
 * one cannot be checked cheaply, and that is reported as `unverifiable` rather
 * than dressed up as success — claiming a check that did not happen is the
 * failure this whole surface is built to avoid. A model catalogue is
 * deliberately not substituted: a menu is not evidence that a key worked.
 *
 * The key never appears in the returned reason. Provider errors are passed
 * through, and a driver that echoes a credential into its own error message
 * would defeat this; that is a driver bug and not one this can paper over, so
 * the reason is also truncated.
 */
export async function verifyCredential(
	id: ProviderId,
	det: DetectedProvider,
	signal?: AbortSignal,
): Promise<{ kind: 'verified' } | { kind: 'unverifiable' } | { kind: 'rejected'; reason: string }> {
	try {
		signal?.throwIfAborted()
		await ensureRegistered(id)
		signal?.throwIfAborted()
		const provider = constructProvider(id, det, det.entry.defaultModel)
		// Declared, never inferred. A driver without a probe is unverifiable —
		// including one added years from now by someone who never reads this.
		// Falling back to the listing here is precisely the defect: it reported a
		// wrong key as verified for two drivers, one because a 401 was swallowed
		// behind a hardcoded catalogue and one because its listing endpoint does
		// not authenticate at all.
		if (typeof provider.probeCredential !== 'function') return { kind: 'unverifiable' }
		await runPickerProviderOperation(
			signal,
			(operationSignal) => provider.probeCredential?.(operationSignal) ?? Promise.resolve(),
		)
		return { kind: 'verified' }
	} catch (err) {
		if (signal?.aborted) throw signal.reason
		if (err instanceof PickerProviderTimeoutError) return { kind: 'unverifiable' }
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
	const status =
		(err as { status?: unknown; statusCode?: unknown } | null)?.status ??
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
	readonly topicId: TopicId
	readonly projectId: ProjectId
	readonly tenantId: TenantId
}

/** One scope per launched TUI session; runId is minted fresh per turn by the SDK. */
function mintScope(): RunScope {
	const suffix = `tui-${Date.now().toString(36)}`
	// Through the constructors rather than as four bare template literals.
	// One suffix shared by four ids is exactly the shape a typo hides in —
	// `top_` and `tnt_` differ by two characters, and the types accept either
	// spelling for either field while they are still structural.
	return {
		sessionId: asSessionId(`ses_${suffix}`),
		topicId: asTopicId(`top_${suffix}`),
		projectId: asProjectId(`prj_${suffix}`),
		tenantId: asTenantId(`tnt_${suffix}`),
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
	rules: [] as AuthorizationRule[],
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
function gateFor(rules: readonly AuthorizationRule[] | undefined) {
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
	// On, and this is the CLI making a choice rather than taking a default.
	// A session's transcript is the only record of what was compacted away;
	// the size trade this costs is the operator's to see and turn off.
	recordShedHistory: true,
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

/** The shipped configuration with the strategy the project chose, if it chose one. */
function compactionConfigFor(compaction: CompactionCliConfig | undefined): CompactionConfig {
	return {
		...COMPACTION_CONFIG,
		strategy: compaction?.strategy ?? COMPACTION_CONFIG.strategy,
		...(compaction?.contextWindowTokens !== undefined
			? { contextWindowTokens: compaction.contextWindowTokens }
			: {}),
	}
}

/**
 * Named rather than positional: the parameters are eleven long and four of
 * them are strings, so `workingDirectory` and `systemPrompt` would sit next
 * to each other with nothing but call order to keep them apart.
 */
interface RunTurnParams {
	readonly provider: LLMProvider
	/** The kernel's compaction configuration for this session, strategy included. */
	readonly compactionConfig: CompactionConfig
	/**
	 * The chain's tail for THIS turn. Empty means no failover, which is what a
	 * one-member chain means and what every chain meant before this existed.
	 */
	readonly fallbackProviders: readonly ProviderChainMember[]
	readonly model: string
	readonly tools: ToolRegistry
	readonly pluginManager: PluginLifecycleManager | undefined
	readonly skillRegistry: SkillRegistry | undefined
	readonly skills: Skill[] | undefined
	readonly scope: RunScope
	/** Exact durable layout shared by turns, resume, and boot migration. */
	readonly pathBuilder: DefaultPathBuilder
	/** Directory every filesystem tool in this turn resolves against. */
	readonly workingDirectory: string
	/** The project tree a sandboxed turn is rooted at. */
	readonly sandboxWorkspace: 'working-directory' | 'ephemeral'
	/** Operator rules for this run, already compiled. */
	readonly rules: readonly AuthorizationRule[] | undefined
	/** Standing verdict on the answer this turn settles with. See {@link AgentSessionOptions}. */
	readonly reviewAnswer: ReviewAnswer | undefined
	readonly maxAnswerReviews: number | undefined
	/** What this run should leave behind when it settles. */
	readonly promoteMemory: PromoteMemory
	/** Exact interactive authority shared with children launched by this run. */
	readonly resumeHandler: ResumeHandler
	readonly taskStore: TaskStore
	readonly systemPrompt: string | undefined
	readonly messages: readonly Message[]
	readonly projectInstructionContext: ProjectInstructionContext
	readonly opts: SendOptions | undefined
	readonly taskGateway: TaskScheduler | undefined
	/** Host text for the `turn` placement; absent means none this session. */
	readonly promptContributions?: PromptContributionRegistry
	/** How this turn reaches the web; absent means the web tools report themselves unwired. */
	readonly web?: NonNullable<Parameters<typeof query>[0]['web']>
	/**
	 * Availability the task tools register with. The kernel's default is
	 * `deferred`, which makes a plan cost a `search_tools` round-trip before
	 * the first `task_create`; an interactive session wants them `active` so
	 * the model plans the way the doctrine tells it to.
	 */
	readonly runtimeToolOverrides?: NonNullable<Parameters<typeof query>[0]['runtimeToolOverrides']>
	/** See {@link AgentSessionOptions.onRunEvent}. */
	readonly onRunEvent: ((event: RunEvent) => void) | undefined
	/**
	 * Where this turn's commands run. Absent means the host process, which
	 * is what every turn did before the CLI built one.
	 */
	readonly sandboxProvider?: SandboxProvider
	/** Operator-selected sandbox teardown bound; absent uses the kernel default. */
	readonly sandboxTeardownTimeoutMs?: number
}

async function* runTurn({
	provider,
	compactionConfig,
	fallbackProviders,
	model,
	tools,
	pluginManager,
	skillRegistry,
	skills,
	scope,
	pathBuilder,
	workingDirectory,
	sandboxWorkspace,
	rules,
	reviewAnswer,
	maxAnswerReviews,
	promoteMemory,
	resumeHandler,
	taskStore,
	systemPrompt,
	messages,
	projectInstructionContext,
	opts,
	taskGateway,
	promptContributions,
	runtimeToolOverrides,
	web,
	sandboxProvider,
	sandboxTeardownTimeoutMs,
	onRunEvent,
}: RunTurnParams): AsyncIterable<AgentEvent> {
	const signal = opts?.signal
	// One presenter for the whole stream, built from the registry this scope
	// already holds. Its absence HERE is what forced presentation to be name
	// matching in the first place: `toAgentEvent` is pure over a `RunEvent`
	// and could not ask a tool anything, so the host guessed from the name.
	const presenter = createToolPresenter(tools)
	try {
		const events = query({
			provider,
			pathBuilder,
			...(opts?.runId ? { runId: opts.runId } : {}),
			// Omitted rather than empty when there is no tail. `query` treats the
			// two the same, but an absent option reads as "this run has no chain"
			// where `[]` reads as "this run has a chain with nothing in it".
			...(fallbackProviders.length > 0 ? { fallbackProviders } : {}),
			tools,
			...(pluginManager ? { pluginManager } : {}),
			...(skillRegistry ? { skillRegistry } : {}),
			...(skills ? { skills } : {}),
			// Withheld at both provider and executor boundaries on every ordinary
			// turn. An admitted send owns the exact run-scoped authority above.
			...(!opts?.goalRound ? { deniedTools: SESSION_GOAL_TOOL_NAMES } : {}),
			taskStore,
			...(taskGateway ? { taskGateway } : {}),
			// `gateFor`, not the bare default: the default's `rules` is a hardcoded
			// empty array, so passing it here discarded the operator's rules on the
			// path that runs every top-level turn. The sub-agent path called
			// `gateFor` and this one did not.
			...(sandboxProvider ? { sandboxProvider } : {}),
			...(sandboxTeardownTimeoutMs !== undefined ? { sandboxTeardownTimeoutMs } : {}),
			authorizationGate: gateFor(rules),
			compactionConfig,
			// The CLI owns its process end to end, so it can safely hand the
			// termination path to the kernel: a Ctrl-C mid-run now leaves a
			// dump under the injected hierarchy's emergency partition instead of
			// losing the turn.
			emergencySave: true,
			runConfig: {
				model,
				...(sandboxProvider ? { sandbox: { workspace: sandboxWorkspace } } : {}),
				...(opts?.effort !== undefined ? { effort: opts.effort } : {}),
				timeoutMs: CLI_INTERACTIVE_RUN_TIMEOUT_MS,
				tokenBudget: 1_000_000,
				maxIterations: 50,
				maxResponseTokens: 8192,
				permissionMode: 'auto',
			},
			// The operator's gate, if they set one. Omitted rather than passed
			// as undefined so a run with no gate is byte-identical to the one
			// that shipped before gates existed.
			...(reviewAnswer ? { reviewAnswer } : {}),
			...(maxAnswerReviews !== undefined ? { maxAnswerReviews } : {}),
			// Always present, unlike the gate: a gate changes what a run may
			// do and so must be asked for; promotion changes only what
			// survives it, and a run that learned nothing still writes
			// nothing.
			promoteMemory,
			agentId: 'namzu',
			agentName: 'namzu',
			...(systemPrompt ? { systemPrompt } : {}),
			projectInstructionContext,
			messages: [...messages],
			...(opts?.inboundMessages ? { inboundMessages: opts.inboundMessages } : {}),
			workingDirectory,
			// The exemption reads `tools` at decision time, so it sees the task
			// tools `query()` registers deferred below and any tool server that
			// connected after this session was built.
			resumeHandler,
			...(promptContributions ? { promptContributions } : {}),
			...(runtimeToolOverrides ? { runtimeToolOverrides } : {}),
			...(web ? { web } : {}),
			signal,
			...scope,
		})
		let settled = false
		try {
			while (true) {
				const next = await events.next()
				if (next.done) {
					settled = true
					// A Run contains its fresh static/dynamic system floor as well as the
					// conversation. Only the latter crosses this host seam. Compaction
					// summaries survive because they ARE conversation state; arbitrary
					// system prompts are rebuilt fresh on every send and stay private to it.
					opts?.onConversationMessages?.(projectRunConversation(next.value.messages))
					return
				}
				const event = next.value
				// Before the abort check and before `toAgentEvent`: a session
				// cancelled mid-turn still produced the events up to that point, and
				// they are the interesting ones. Every event, not just the ones the
				// TUI renders — an export that only saw what the screen showed would
				// be a recording of the interface rather than of the session.
				onRunEvent?.(event)
				if (signal?.aborted) {
					yield { kind: 'error', message: 'aborted' }
					return
				}
				const mapped = toAgentEvent(event, presenter)
				if (!mapped) continue
				yield mapped
			}
		} finally {
			// Manual iteration is what exposes the generator's Run return value.
			// Preserve `for await`'s other guarantee too: a consumer that stops
			// early must close the live query instead of abandoning its transport.
			if (!settled) await drainIterator(events)
		}
	} catch (err) {
		yield {
			kind: 'error',
			message: err instanceof Error ? err.message : String(err),
		}
	}
}

/**
 * The kernel's review policy with the TUI's prompt behind it.
 *
 * The five modes, the exemptions and the batch rule live in `@namzu/sdk`
 * (`createReviewHandler`); what this application adds is the person to ask
 * and the session's "approve all" box, which the screen also reads.
 */
export function makeResumeHandler(
	approval: { all: boolean },
	onPermission: PermissionFn | undefined,
	mode: PermissionMode = onPermission ? 'prompt' : 'auto',
	exempt: (name: string, input: unknown) => boolean = () => false,
): ResumeHandler {
	return createReviewHandler({
		mode,
		prompt: onPermission,
		exempt,
		remembered: approval,
	})
}

/**
 * Whether a call runs without asking. The kernel's rule: a trusted read-only
 * declaration or a named bookkeeping write, never a fetch, never a tool the
 * registry does not know.
 */
export const isPromptExempt: (registry: ToolRegistry, name: string, input: unknown) => boolean =
	isReviewExempt

/** The exempt roster, sorted, for the surface that has to NAME it. */
export function promptExemptToolNames(registry: ToolRegistry): readonly string[] {
	return registry
		.getCallableTools()
		.filter((t) => isPromptExempt(registry, t.name, {}))
		.map((t) => t.name)
		.sort()
}

/** A batch needs explicit approval when any call mutates state. */
export const batchNeedsPrompt = batchNeedsReview

/**
 * Translate one SDK `RunEvent` into the TUI's `AgentEvent` vocabulary, or
 * `null` for events the chat surface doesn't render (iteration markers,
 * token usage, checkpoints, plan/task lifecycle, …). Pure — unit-tested.
 */
export function toAgentEvent(event: RunEvent, presenter: ToolPresenter): AgentEvent | null {
	switch (event.type) {
		case 'text_delta':
			return {
				kind: 'delta',
				text: event.text,
				...(event.messageId ? { messageId: event.messageId } : {}),
				...(event.runId ? { runId: event.runId } : {}),
			}
		case 'reasoning_started':
			// A redacted block has no text to show; the empty delta still says
			// "thinking" so the region does not sit silent for its duration.
			return { kind: 'reasoning', text: '' }
		case 'reasoning_delta':
			return { kind: 'reasoning', text: event.text }
		case 'reasoning_completed':
			return { kind: 'reasoning', text: '', done: true }
		case 'tool_executing':
			return {
				kind: 'tool-start',
				runId: event.runId,
				toolUseId: event.toolUseId,
				toolName: event.toolName,
				...(() => {
					const view = presenter.presentCall(event.toolName, event.input)
					return {
						summary: viewToSummary(view),
						detail: viewToLines(view),
						...(view.kind === 'generic' && view.presentation === 'activity'
							? { standalone: true }
							: {}),
					}
				})(),
			}
		case 'tool_progress':
			return {
				kind: 'tool-progress',
				runId: event.runId,
				toolUseId: event.toolUseId,
				toolName: event.toolName,
				message: event.message,
				...(event.fraction !== undefined ? { fraction: event.fraction } : {}),
			}
		case 'tool_completed': {
			const view = presenter.presentResult(
				event.toolName,
				{},
				{
					success: !event.isError,
					output: event.result,
				},
			)
			const detail = viewToLines(view)
			// For output shown line by line, the summary IS the first rendered
			// line, so the body can drop it without a second, differently
			// whitespaced copy of the same text — a `read` used to show its
			// first line twice, once collapsed and once numbered.
			const summary =
				view.kind === 'terminal' && detail && detail.length > 0
					? truncate(detail[0] as string, 120)
					: firstLine(event.result)
			const withoutRepeatedSummary =
				view.kind === 'terminal' && detail && detail.length > 0 ? detail.slice(1) : detail
			return {
				kind: 'tool-end',
				runId: event.runId,
				toolUseId: event.toolUseId,
				toolName: event.toolName,
				isError: event.isError,
				summary,
				...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
				...(view.kind === 'generic' && view.visibility === 'hidden' ? { hidden: true } : {}),
				// `tool_completed` carries no input, so the presenter gets an
				// empty one. A tool whose result rendering depends on its
				// arguments would need the executing event's input threaded
				// through; none does yet, and inventing the plumbing for a
				// caller that does not exist is the declaration this repo
				// keeps deleting.
				...(withoutRepeatedSummary && withoutRepeatedSummary.length > 0
					? { detail: withoutRepeatedSummary }
					: {}),
			}
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
				cost: event.cost,
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
		case 'capability_warning':
			return {
				kind: 'capability-warning',
				capability: event.capability,
				...(event.contentSource ? { contentSource: event.contentSource } : {}),
				text: event.message,
			}
		case 'message_history_repaired': {
			if (event.source === 'provider-rejected-image') {
				const count = event.providerRejectedImagesSuppressed ?? 0
				return {
					kind: 'history-repair',
					source: event.source,
					text: `The provider rejected ${count} image occurrence${count === 1 ? '' : 's'}. The original attachment bytes were kept, but that image will be omitted from later model requests; attach a corrected copy to try again.`,
				}
			}
			const changes = [
				event.duplicateToolResultsRemoved > 0
					? `${event.duplicateToolResultsRemoved} duplicate result${event.duplicateToolResultsRemoved === 1 ? '' : 's'} removed`
					: null,
				event.orphanedToolResultsRemoved > 0
					? `${event.orphanedToolResultsRemoved} orphaned result${event.orphanedToolResultsRemoved === 1 ? '' : 's'} removed`
					: null,
				event.syntheticToolResultsInserted > 0
					? `${event.syntheticToolResultsInserted} interrupted call${event.syntheticToolResultsInserted === 1 ? '' : 's'} closed with unknown outcome`
					: null,
			].filter((part): part is string => part !== null)
			return {
				kind: 'history-repair',
				source: event.source,
				text: `Tool history repaired before the model call: ${changes.join('; ')}. Verify external state before retrying non-idempotent tools.`,
			}
		}
		case 'task_created':
		case 'task_updated':
			// Every change, not only completions: the live task list needs the
			// in-progress flips to show which step is current. The transcript
			// decides for itself which of these it records.
			return {
				kind: 'task',
				taskId: String(event.taskId),
				subject: event.subject,
				status: event.status,
			}
		case 'run_paused':
			// A pause is not an error and not an invisible end. The checkpoint and
			// classification are the recovery surface; dropping this event made a
			// shell report success and let the interactive queue run on a premise
			// the SDK had explicitly stopped.
			return {
				kind: 'paused',
				checkpointId: event.checkpointId,
				reason: event.reason,
				...(event.failure ? { failure: event.failure } : {}),
				...(event.providerError ? { providerError: event.providerError } : {}),
				...(event.explanation ? { explanation: event.explanation } : {}),
			}
		case 'run_completed':
			// Carried through rather than dropped: `run_failed` fires only from
			// the throw path, so this event is also how a budget stop, a
			// timeout, a cancellation and a blocked output guardrail arrive. A
			// consumer that reads this as success reports one for a run whose
			// answer was refused.
			return {
				kind: 'done',
				...(event.stopReason ? { stopReason: event.stopReason } : {}),
			}
		case 'run_failed':
			// Keep the compatibility string and the structure. Prefixing the
			// message with only the coarse `provider_error` code discarded the
			// stable explanation, retry delay and first-hand provider detail while
			// still forcing every host to parse prose.
			return {
				kind: 'error',
				message: event.error,
				...(event.failure ? { failure: event.failure } : {}),
				...(event.providerError ? { providerError: event.providerError } : {}),
				...(event.explanation ? { explanation: event.explanation } : {}),
			}
		case 'compaction_completed':
			return { kind: 'context', text: describeCompaction(event), shed: true }
		case 'compaction_tool_results_cleared':
			// `shed: true` on both branches: the tool-result bodies are gone
			// either way. `reliefWasEnough: false` additionally means a
			// summarization followed, and the reader will see its own line —
			// so this one says what IT cost rather than claiming the total.
			return {
				kind: 'context',
				text: `cleared ${event.clearedCount} tool result${event.clearedCount === 1 ? '' : 's'}${event.stubbedCount ? `, stubbed ${event.stubbedCount} narration${event.stubbedCount === 1 ? '' : 's'}` : ''} (~${event.reclaimedTokens.toLocaleString()} tokens)${event.reliefWasEnough ? '' : ' — not enough, compacting'}`,
				shed: true,
			}
		case 'compaction_failed':
			return {
				kind: 'context',
				text: describeCompactionFailure(event),
				shed: false,
			}
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

/**
 * The one presentation function this host keeps.
 *
 * There used to be four, and each switched on a lowercased tool NAME:
 * `name === 'write'` and `name === 'edit'` got a diff, everything else got
 * a truncated string. So a tool this host had never heard of — an MCP
 * server's, a plugin's — could not get a diff no matter what it did.
 *
 * The tool now says which admitted shape it wants, and this decides what
 * that looks like in a terminal. Clamping and the `STDOUT:`/`STDERR:`
 * cleanup stay here on purpose: how many rows fit and how a shell labels
 * its streams are properties of this surface, not of the tool.
 */
export function viewToLines(view: ToolResultView): readonly string[] | undefined {
	switch (view.kind) {
		case 'generic':
			// The label IS the summary row. Repeating it underneath adds a
			// line that says what the line above it already said.
			return undefined
		case 'diff': {
			// An empty `before` is a whole-file write, not a patch: there is
			// nothing to contrast against, so the content reads plainly. `edit`
			// never produces this — it returns no view at all for an insert,
			// rather than claim the file was empty.
			if (view.before === '') {
				const lines = clampLines(view.after)
				return lines.length > 0 ? lines : undefined
			}
			const lines: string[] = []
			for (const line of clampLines(view.before)) lines.push(`- ${line}`)
			for (const line of clampLines(view.after)) lines.push(`+ ${line}`)
			return lines.length > 0 ? lines : undefined
		}
		case 'terminal': {
			if (view.output.trim().length === 0) return undefined
			const lines = resultToLines(view.output)
			// A single short line is already the summary — no need to repeat it.
			return lines.length <= 1 ? undefined : lines
		}
	}
}

/** The `⏺` row: one line naming what the call is about. */
export function viewToSummary(view: ToolCallView): string {
	switch (view.kind) {
		case 'generic':
			return truncate(view.label, 120)
		case 'diff':
			return truncate(view.path ?? view.after.split('\n')[0] ?? '', 120)
		case 'terminal':
			return truncate(view.command ?? view.output.split('\n')[0] ?? '', 120)
	}
}

function truncate(value: string, max: number): string {
	const oneLine = value.replace(/\s+/g, ' ')
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

const MAX_DETAIL_LINES = 200

function clampLines(value: string): string[] {
	const lines = value.replace(/\s+$/, '').split('\n')
	return lines.length > MAX_DETAIL_LINES ? lines.slice(0, MAX_DETAIL_LINES) : lines
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

function exceptionAttributes(err: unknown): LogAttributes {
	const error = err instanceof Error ? err : new Error(String(err))
	return {
		'exception.type': error.constructor?.name ?? 'Error',
		'exception.message': error.message,
	}
}

/**
 * `namzu.capability.detected` per package at `debug`, one aggregate summary
 * at `info` (the design's §6.3 `capability sandbox yes · files yes · …`
 * line), and `namzu.capability.broken` at `error` for any package that
 * resolved and failed to load. Never refuses the boot: nothing in
 * `NamzuCliConfig` marks a capability required yet, so `broken` here is
 * always the "not required by config" case §6.5 describes — an optional
 * capability's failure degrades what this line SAYS, never whether
 * `namzu.boot.ready` fires. The aggregate's sandbox/computer-use answers are
 * runtime reachability, not package presence: both have a separate admission
 * step, and printing the package probe after that step produced contradictory
 * adjacent rows.
 */
function logCapabilities(
	probes: readonly CapabilityProbe[],
	runtime: {
		readonly sandboxReady: boolean
		readonly computerUseReady: boolean
		readonly computerUseError?: Error
	},
): void {
	const log = cliLogger()
	const summary = probes
		.map((p) => {
			const present =
				p.specifier === '@namzu/sandbox'
					? runtime.sandboxReady
					: p.specifier === '@namzu/computer-use'
						? runtime.computerUseReady
						: p.state === 'present'
			return `${p.specifier.split('/').pop()} ${present ? 'yes' : 'no'}`
		})
		.join(' · ')
	log.info(summary, {
		[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.CAPABILITY_DETECTED,
	})
	for (const probe of probes) {
		if (probe.state === 'broken') {
			log.error('Capability probe failed to load', {
				[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.CAPABILITY_BROKEN,
				'namzu.capability.name': probe.specifier,
				...exceptionAttributes(probe.error),
			})
			continue
		}
		log.debug('Capability probe completed', {
			[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.CAPABILITY_DETECTED,
			'namzu.capability.name': probe.specifier,
			'namzu.capability.state': probe.state,
			'namzu.capability.present': probe.state === 'present',
			...(probe.state === 'present' ? { 'namzu.capability.version': probe.version } : {}),
		})
	}
	if (runtime.computerUseError) {
		log.warn('Computer use adapter is unavailable', {
			[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.CAPABILITY_DETECTED,
			'namzu.capability.name': '@namzu/computer-use',
			'namzu.capability.state': 'unavailable',
			'namzu.capability.present': false,
			...exceptionAttributes(runtime.computerUseError),
		})
	}
}

function emptySession(
	errorHint: string,
	errorKind: 'invocation' | 'environment' = 'environment',
): AgentSession {
	// Every path into this function is a boot refusal — `createAgentSession`
	// is the whole extent of the session-construction half of the boot
	// narrative, and every one of its early returns comes through here. One
	// emission point instead of five call-site ones is what keeps that true
	// instead of "true until the sixth `emptySession(...)` someone adds
	// forgets it."
	cliLogger().error(errorHint, {
		[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.BOOT_REFUSED,
		'namzu.refusal.kind': errorKind,
	})
	return {
		hasProvider: false,
		// A refused session ran nothing, so there is nothing confining anything.
		// Reporting an enforced control here would be a claim about a sandbox
		// this path never built.
		sandbox: { unconfined: true, enforced: [], required: [] },
		// No provider, so no summary can be built. Refusing is the honest
		// answer; returning `null` would say "nothing to shed".
		compact: async () => {
			throw new Error('No provider: pick one with /model before compacting.')
		},
		errorKind,
		providerSummary: null,
		modelSummary: null,
		toolNames: () => [],
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
		resetApprovalLatch: () => {},
		// No registry was built, so there is no roster to report on.
		promptExemptTools: () => [],
		send: async function* () {
			yield { kind: 'error' as const, message: errorHint }
		},
		// Throws rather than reporting `no-checkpoint`. A resume that reported
		// "there is nothing to continue" when the truth is "this session has no
		// provider" would let a drainer mark every run in a queue as a dead end
		// and move on — an unavailable capability degrading a check into a
		// wrong answer, on the one path where the answer is destructive.
		resumeDurable: async () => {
			throw new Error(errorHint)
		},
		close: async () => {
			// Nothing was ever connected on this path.
		},
	}
}
