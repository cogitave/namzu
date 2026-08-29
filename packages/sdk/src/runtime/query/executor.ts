import type { Span } from '@opentelemetry/api'
import type { AuthorizationGate } from '../../authorization/gate.js'
import { extractFromToolCall, extractFromToolResult } from '../../compaction/extractor.js'
import type { WorkingStateManager } from '../../compaction/manager.js'
import { GENAI, NAMZU } from '../../constants/telemetry/index.js'
import type { PluginLifecycleManager } from '../../plugin/lifecycle.js'
import { buildProbeContext } from '../../probe/context.js'
import { ProbeVetoError } from '../../probe/errors.js'
import { probe as defaultProbeRegistry } from '../../probe/registry.js'
import type { ProbeEnforcement } from '../../probe/registry.js'
import { renderToolSchema } from '../../registry/tool/schema.js'
import type { ActivityStore } from '../../store/activity/memory.js'
import { fingerprintContent } from '../../tools/builtins/content-fingerprint.js'
import { SKILL_TOOL_NAME } from '../../tools/builtins/skill.js'
import type { RunId, ToolUseId } from '../../types/ids/index.js'
import type { InvocationState } from '../../types/invocation/index.js'
import {
	type Message,
	type ToolCall,
	type ToolResultContent,
	createToolMessage,
} from '../../types/message/index.js'
import type { PermissionMode } from '../../types/permission/index.js'
import type { PluginHookResult } from '../../types/plugin/index.js'
import type { ChatCompletionResponse } from '../../types/provider/index.js'
import type { AuditEventInput } from '../../types/run/audit.js'
import type { RunEvent } from '../../types/run/index.js'
import type { Sandbox } from '../../types/sandbox/index.js'
import type {
	FileReadTracker,
	PreparedToolExecution,
	RequestToolPause,
	SkillRegistryRef,
	ToolContext,
	ToolDispatchOptions,
	ToolRegistryContract,
	ToolResult,
} from '../../types/tool/index.js'
import type {
	RepairToolCall,
	ToolCallRepair,
	ToolCallRepairReason,
} from '../../types/tool/repair.js'
import { abortReasonText } from '../../utils/abort.js'
import { type BackoffPolicy, backoffWithJitter, sleep } from '../../utils/backoff.js'
import { toErrorMessage } from '../../utils/error.js'
import { generateToolCallId } from '../../utils/id.js'
import type { Logger } from '../../utils/logger.js'
import { compressShellOutput } from '../../utils/shell-compress.js'
import { type BackgroundJobRegistry, bindOwner } from '../jobs/registry.js'
import type { ToolResultObservation } from './project-instructions.js'
import {
	DEFAULT_MAX_TOOL_OUTPUT_CHARS,
	applyToolOutputBudget,
	describeDroppedContent,
	measureContentBytes,
} from './tool-output-budget.js'

export type EmitEvent = (event: RunEvent) => Promise<void>

type PreparedDirectCall =
	| {
			readonly kind: 'ready'
			readonly toolCall: ToolCall
			readonly toolName: string
			readonly input: unknown
			readonly prepared: PreparedToolExecution
	  }
	| {
			readonly kind: 'legacy'
			readonly toolCall: ToolCall
			readonly toolName: string
			readonly input: unknown
	  }
	| {
			readonly kind: 'synthetic'
			readonly toolCall: ToolCall
			readonly toolName: string
			readonly input: unknown
			readonly message: string
			readonly isError: boolean
	  }

/**
 * Executor-owned, single-use preparation of one provider tool-call batch.
 *
 * Consumers may inspect `reviewCalls`; only the creating executor can consume
 * the opaque call preparations. This keeps schema transforms, plugin rewrites,
 * authorization and execution on one value instead of reparsing between them.
 */
export interface PreparedToolBatch {
	readonly reviewCalls: readonly {
		readonly id: string
		readonly name: string
		readonly input: unknown
	}[]
}

interface OwnedPreparedToolBatch extends PreparedToolBatch {
	readonly calls: ReadonlyMap<string, PreparedDirectCall>
}

function assertUniqueToolCallIds(toolCalls: readonly ToolCall[]): void {
	const seen = new Set<string>()
	for (const [index, toolCall] of toolCalls.entries()) {
		if (seen.has(toolCall.id)) {
			throw new Error(
				`Provider returned duplicate tool call id "${toolCall.id}" at batch index ${index}; the batch is refused because review, denial and result ownership require one unique id per call.`,
			)
		}
		seen.add(toolCall.id)
	}
}

type PreparedNestedCall =
	| {
			readonly kind: 'ready'
			readonly input: unknown
			readonly prepared: PreparedToolExecution
	  }
	| { readonly kind: 'legacy'; readonly input: unknown }
	| {
			readonly kind: 'synthetic'
			readonly input: unknown
			readonly message: string
			readonly isError: boolean
	  }

/**
 * Default per-tool deadline. Long enough for a real build or test run,
 * short enough that a wedged tool does not hold a turn open indefinitely.
 * A tool that legitimately runs longer declares its own `timeoutMs`.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000

/**
 * Cap on tools executing at once within a single batch.
 *
 * `executeBatch` used to `Promise.all` an unbounded fan-out, so a model
 * emitting fifty parallel reads opened fifty file handles and fifty
 * activity records at once. The serial chain is unaffected — it is
 * already one-at-a-time by construction.
 */
export const DEFAULT_TOOL_CONCURRENCY = 8

/** Maximum UTF-8 size of one ephemeral tool-progress update. */
const MAX_TOOL_PROGRESS_BYTES = 8 * 1024

/** A visible marker: this event is a display projection, not durable output. */
const TOOL_PROGRESS_OMISSION = '… '

function boundedToolProgress(message: string): string {
	if (Buffer.byteLength(message, 'utf8') <= MAX_TOOL_PROGRESS_BYTES) return message

	const tailBudget = MAX_TOOL_PROGRESS_BYTES - Buffer.byteLength(TOOL_PROGRESS_OMISSION, 'utf8')
	let low = 0
	let high = message.length
	while (low < high) {
		const middle = Math.floor((low + high) / 2)
		if (Buffer.byteLength(message.slice(middle), 'utf8') > tailBudget) low = middle + 1
		else high = middle
	}
	// Do not turn the low half of a retained surrogate pair into U+FFFD.
	if (
		low > 0 &&
		low < message.length &&
		message.charCodeAt(low) >= 0xdc00 &&
		message.charCodeAt(low) <= 0xdfff &&
		message.charCodeAt(low - 1) >= 0xd800 &&
		message.charCodeAt(low - 1) <= 0xdbff
	) {
		low += 1
	}
	return `${TOOL_PROGRESS_OMISSION}${message.slice(low)}`
}

/**
 * Latest-state publisher for one tool call.
 *
 * `ToolContext.report()` is synchronous by contract, while host event
 * listeners may be arbitrarily slow. Starting one promise per report makes a
 * chatty tool an unbounded allocation source. Progress is state rather than a
 * transcript, so one in-flight update plus the latest pending update is the
 * complete useful working set; intermediate states may be replaced.
 */
class ToolProgressPublisher {
	private pending: { readonly message: string; readonly fraction?: number } | undefined
	private draining: Promise<void> | null = null
	private accepting = true

	constructor(
		private readonly emitEvent: EmitEvent,
		private readonly base: Omit<
			Extract<RunEvent, { type: 'tool_progress' }>,
			'message' | 'fraction'
		>,
	) {}

	report(message: string, fraction?: number): void {
		if (!this.accepting) return
		this.pending = {
			message,
			...(fraction !== undefined ? { fraction: Math.min(1, Math.max(0, fraction)) } : {}),
		}
		this.startDrain()
	}

	async close(): Promise<void> {
		this.accepting = false
		this.startDrain()
		while (this.draining) await this.draining
	}

	private startDrain(): void {
		if (this.draining || !this.pending) return
		const current = this.drain()
		this.draining = current
		void current.finally(() => {
			if (this.draining !== current) return
			this.draining = null
			// A report can land after the final loop check but before this
			// settlement callback. It is still an accepted update and must be
			// drained even when close() has since stopped new reports.
			this.startDrain()
		})
	}

	private async drain(): Promise<void> {
		while (this.pending) {
			const update = this.pending
			this.pending = undefined
			// A progress observer is diagnostic. Its failure cannot become a tool
			// failure, and report() never hands a rejection back to the tool.
			await this.emitEvent({
				...this.base,
				message: boundedToolProgress(update.message),
				...(update.fraction !== undefined ? { fraction: update.fraction } : {}),
			}).catch(() => {})
		}
	}
}

/**
 * Re-runs granted to a `post_tool_use` hook that returns `{action:'retry'}`
 * on a tool which did not opt into {@link ToolDefinition.maxRetries}.
 *
 * Small on purpose. The hook is host code reacting to one specific result,
 * which is a more specific signal than the tool's blanket idempotency
 * declaration — but the tool still never said it was safe to re-run, so
 * this buys one correction, not a loop.
 */
export const HOOK_RETRY_BUDGET = 1

/**
 * Wait between in-loop tool retry attempts.
 *
 * There was none. A tool that declared itself retryable was re-run the
 * instant it failed, as many times as its budget allowed — and the failures
 * worth retrying are the ones an immediate retry makes worse: a rate limit
 * answers the second call faster than it recovers, a contended lock is still
 * held, a connection that has not finished opening has not finished opening.
 *
 * The numbers are the provider policy's, deliberately, and not because a tool
 * is a model call. Nothing here has been measured against tools specifically,
 * and inventing a second curve to look considered would be a guess wearing
 * different digits; the shared one is at least the curve this codebase has
 * already run in anger. Full jitter draws each wait from `[0, curve]`, so the
 * first retry of a tool with the shipped budget waits under half a second on
 * average.
 *
 * The ceiling is inert at the budgets anyone sets — a tool declaring
 * `maxRetries: 3` never reaches 2s — and binds only a host that sets a large
 * one. Override with {@link ToolExecutorConfig.toolRetryBackoff}; set
 * `initialDelayMs: 0` for the previous no-wait behaviour.
 */
export const DEFAULT_TOOL_RETRY_BACKOFF: BackoffPolicy = {
	initialDelayMs: 500,
	maxDelayMs: 16_000,
}

/**
 * An empty arguments string means "no arguments", not "malformed" — the
 * shape a no-parameter tool arrives in.
 */
function parseArguments(raw: string): unknown {
	return JSON.parse(raw || '{}')
}

export interface ToolExecutorConfig {
	tools: ToolRegistryContract
	runId: RunId
	workingDirectory: string
	/**
	 * Read LIVE, not frozen at run start.
	 *
	 * The mode used to be resolved once per run and copied in here, so
	 * leaving plan mode meant ending the run — discarding the in-flight step
	 * and the tool-schema context to change one enum. A function lets an
	 * approval flip it inside the same conversation.
	 *
	 * Sampled ONCE per batch and held for it: a toggle landing between two
	 * calls the model issued together would half-apply, and a batch where
	 * the first write is refused and the second succeeds is not a state
	 * anyone can reason about.
	 */
	permissionMode: PermissionMode | (() => PermissionMode)
	env: Record<string, string>
	abortSignal: AbortSignal
	allowedTools?: readonly string[]
	sandbox?: Sandbox
	/**
	 * Where background jobs this run starts are held.
	 *
	 * The registry is host-owned and shared; the executor binds it to THIS
	 * run's id before a tool ever sees it, so a tool cannot start a job
	 * billed to another run, nor read or kill one. Absent means the host
	 * offers no background mode, and `bash run_in_background` refuses rather
	 * than falling back to `cmd &` — see `runtime/jobs/registry.ts` for why
	 * that fallback is a lie rather than a lesser version.
	 */
	backgroundJobs?: BackgroundJobRegistry

	/**
	 * Where the `skill` tool reads from.
	 *
	 * Structural (`SkillRegistryRef`) rather than `SkillRegistry`, because
	 * this config is host-facing and a host may hold its skills anywhere.
	 */
	skills?: SkillRegistryRef
	/** How this run reaches the web. See `ToolContext.web`. */
	web?: ToolContext['web']
	invocationState?: InvocationState
	pluginManager?: PluginLifecycleManager
	/** Run-level default deadline; per-tool `timeoutMs` overrides it. */
	toolTimeoutMs?: number
	/**
	 * Wait between in-loop retries of a failed tool call. Defaults to
	 * {@link DEFAULT_TOOL_RETRY_BACKOFF}.
	 *
	 * Applies only to a tool that opted into retrying at all
	 * ({@link ToolDefinition.maxRetries}) or to a `post_tool_use` hook that
	 * asked for one, so a run whose tools all take the shipped default of
	 * zero retries never sleeps here.
	 */
	toolRetryBackoff?: Partial<BackoffPolicy>
	/** Max concurrently-executing concurrency-safe tools. */
	maxToolConcurrency?: number

	/**
	 * Builds the durable-pause seam handed to one tool call.
	 *
	 * Absent when the run has no route to a human, which is why
	 * {@link ToolContext.requestPause} is optional: a tool must be able to
	 * run in a headless context and decide what to do without one.
	 */
	toolPause?: (toolUseId: string) => RequestToolPause
	/**
	 * Model-visible size cap for a single tool result. Defaults to
	 * {@link DEFAULT_MAX_TOOL_OUTPUT_CHARS}; set `0` to disable.
	 */
	maxToolOutputChars?: number

	/**
	 * Cap on the RICH channel of a single tool result, in base64
	 * characters. `0` or absent disables it.
	 *
	 * Separate from {@link maxToolOutputChars} because the two are different
	 * quantities with different costs: the text budget bounds characters the
	 * model reads, and an image block of any size passed it untouched — the
	 * single largest payload a tool result can carry was the one thing not
	 * bounded on the turn that produced it.
	 *
	 * **Off by default, deliberately.** The right number depends entirely on
	 * what a host's tools return and on the model's own image budget, and
	 * inventing one here would either break screenshot workflows or be so
	 * generous it bounds nothing. A host that knows its payloads sets it;
	 * the steady state is already bounded, because reclamation clears
	 * image-bearing results first.
	 */
	maxToolContentBytes?: number

	/**
	 * Where over-budget output is spilled so the model can read it back
	 * with `read`/`grep`. Absent ⇒ over-budget output is middle-elided and
	 * the overflow is lost.
	 */
	toolOutputDir?: string
	/**
	 * Last chance to fix a tool call the model got wrong, before the error
	 * reaches it. See {@link RepairToolCall}.
	 */
	repairToolCall?: RepairToolCall
	/**
	 * Operator policy applied to calls dispatched by another tool.
	 *
	 * Model-issued calls are reviewed by the iteration orchestrator. Nested
	 * calls cannot open a second durable review while their parent is already
	 * executing, so only an explicit `allow` may proceed; `deny` and `review`
	 * both fail closed before the registry is touched.
	 */
	authorizationGate?: AuthorizationGate
	/** Durable refusal sink paired with {@link authorizationGate}. */
	recordAudit?: (input: AuditEventInput) => Promise<unknown>
}

/**
 * What a `post_tool_use` hook decided to show the model instead.
 *
 * `isError` is the field this type exists for. The override used to be a bare
 * string, so the executor had no way to tell "the call failed" from "the call
 * succeeded and the model may not see all of it" — and it assumed the first,
 * which turned every redaction into a reported tool failure.
 */
interface PostToolOverride {
	readonly output: string
	readonly isError: boolean
	readonly content?: ToolResultContent
}

type PreToolHookOutcome =
	| { kind: 'continue'; input: unknown; modified: boolean }
	| { kind: 'skip'; input: unknown; output: string }
	| { kind: 'error'; input: unknown; output: string }

/** What one tool call produced, before it becomes a message. */
export interface ToolCallOutcome {
	toolCallId: string
	/** Which tool produced it. */
	toolName: string
	/** Text form — what the host, the transcript and compaction see. */
	output: string
	/** Rich form for the model, when the tool supplied one. */
	content?: ToolResultContent
	isError?: boolean
}

export interface ToolExecutionBatch {
	messages: Message[]
	results: ToolCallOutcome[]
	/** Actual registry executions, including calls dispatched by another tool. */
	observations: ToolResultObservation[]
}

/**
 * Denial reasons keyed by `tool_use` id. Any id present here is answered
 * with a synthetic `tool_result` carrying the reason INSTEAD of being
 * executed — see {@link ToolExecutor.executeBatch}.
 */
export type ToolCallDenials = ReadonlyMap<string, string>

/**
 * Results for calls that already ran, keyed by `toolUseId`.
 *
 * A batch's results reach the history only when the whole batch settles,
 * so a hard kill part-way through loses whatever had already come back and
 * the resumed run re-executes those calls. Supplying them here answers
 * those `tool_use` blocks from the record instead of by running the tool
 * again — which for a payment or an email is the difference between
 * resuming and repeating.
 */
export type PriorToolResults = ReadonlyMap<string, { result: string; isError: boolean }>

/**
 * Model-visible text for a tool call that was never executed.
 *
 * The reason travels INSIDE the `tool_result` rather than as a trailing
 * user message: a `tool_use` block must be answered by a `tool_result`
 * with the same id, and a denial is an answer, not an omission. Putting
 * the reason here is also what makes rejection *steer* — the model reads
 * it in the slot it already attends to for tool outcomes.
 */
export function deniedToolOutput(toolName: string, reason: string): string {
	return `Error: Tool "${toolName}" was not executed. ${reason}`
}

export class ToolExecutor {
	private config: ToolExecutorConfig
	private activityStore: ActivityStore
	private emitEvent: EmitEvent
	private log: Logger
	private workingStateManager?: WorkingStateManager
	private probes: ProbeEnforcement
	private parentSpan?: Span
	private readonly preparedBatches = new WeakSet<PreparedToolBatch>()
	/** Set per turn by the orchestrator; see {@link setStepAllowedTools}. */
	private stepAllowedTools?: readonly string[]
	private readonly readPaths: Set<string> = new Set()
	private readonly readFingerprints: Map<string, string> = new Map()
	private readonly fileReadTracker: FileReadTracker = {
		recordRead: (key: string, content?: string) => {
			this.readPaths.add(key)
			// Only when the reader had the body. A tool that records a read
			// without one leaves the previous fingerprint alone rather than
			// clearing it, so a later write is still checked against the last
			// body anyone actually saw.
			if (content !== undefined) this.readFingerprints.set(key, fingerprintContent(content))
		},
		hasRead: (key: string) => this.readPaths.has(key),
		fingerprint: (key: string) => this.readFingerprints.get(key),
	}

	constructor(
		config: ToolExecutorConfig,
		activityStore: ActivityStore,
		emitEvent: EmitEvent,
		log: Logger,
		probes: ProbeEnforcement = defaultProbeRegistry,
	) {
		this.config = config
		this.activityStore = activityStore
		this.emitEvent = emitEvent
		this.log = log
		this.probes = probes
	}

	setWorkingStateManager(manager: WorkingStateManager): void {
		this.workingStateManager = manager
	}

	setSandbox(sandbox: Sandbox): void {
		this.config = { ...this.config, sandbox }
	}

	/**
	 * Span that this executor's tool spans should hang off — the current
	 * iteration. Re-set each turn by the orchestrator, because a tool span
	 * belongs under the iteration that requested it.
	 */
	setParentSpan(span: Span | undefined): void {
		this.parentSpan = span
	}

	/**
	 * Narrow what this turn may call, or clear the narrowing.
	 *
	 * Re-set each turn by the orchestrator for the same reason the parent span
	 * is: `prepareStep` can hand a different list to every step, and the run's
	 * own `allowedTools` is only the default when a step names none.
	 *
	 * Without this the executor could only ever see the RUN-level list, so a
	 * per-step narrowing reached the request that was sent and nothing else —
	 * the model was shown fewer tools and could still call all of them.
	 */
	setStepAllowedTools(names: readonly string[] | undefined): void {
		this.stepAllowedTools = names
	}

	/**
	 * Answer every `tool_use` block in `response` with exactly one
	 * `tool_result`.
	 *
	 * `denials` marks ids that must NOT run: each is answered with a
	 * synthetic error result carrying the caller's reason instead of being
	 * executed. This is what makes the invariant hold by construction —
	 * a gate denial, a human rejection and a partial approval all leave
	 * the history valid, because there is exactly one place that turns a
	 * batch of tool calls into messages and it always covers all of them.
	 *
	 * Answering with `is_error` semantics rather than dropping the call is
	 * the universal contract across providers: an unanswered `tool_use`
	 * is a protocol violation, not a decline.
	 */
	/**
	 * The mode sampled for the batch currently running, if one is.
	 *
	 * Belt-and-braces, and worth saying so. The per-batch property is
	 * ALREADY structural: `buildToolContext()` runs once per batch and every
	 * per-call context spreads its result, so the mode is read once whether
	 * or not this field exists — removing it is an equivalent mutation
	 * today, measured.
	 *
	 * Kept because that guarantee is incidental to where the context happens
	 * to be built. Moving `permissionContext` into the per-call spread is a
	 * plausible refactor and would silently make the read per-call, which is
	 * a batch where the first write is refused and the second succeeds.
	 */
	private batchMode?: PermissionMode

	/**
	 * The tool scope a loaded skill declared, and the batch it applies from.
	 *
	 * `allowed-tools` was parsed, stored and rendered into the prompt, and
	 * read by nothing — advice phrased as a declaration. This is what makes
	 * it a restriction, on the same line that already enforces the step's
	 * list, because a narrowing the model can decline is not one.
	 *
	 * Two fields rather than one, and the second is the point: a skill
	 * loaded MID-batch must not retroactively refuse the calls the model
	 * issued alongside it. The model chose that batch under the old scope,
	 * and refusing half of it teaches nothing except that tools fail at
	 * random. `adoptedInBatch` is compared against the batch counter, so the
	 * scope takes effect from the next one.
	 *
	 * **`adoptedInBatch` is redundant TODAY and kept deliberately**, the same
	 * bargain `batchMode` above documents. `buildToolContext()` runs once per
	 * batch, so every call in a batch already shares one `allowedTools` array
	 * computed before any of them could adopt anything — remove this
	 * comparison and no test changes, because the guarantee currently comes
	 * from where the context happens to be built rather than from here.
	 * Moving the context into the per-call spread is a plausible refactor,
	 * and it would silently produce a batch whose second half is refused for
	 * a scope its first half installed. That is precisely the incoherent
	 * batch this line exists to make impossible.
	 */
	private skillScope?: {
		skill: string
		allowedTools: readonly string[]
		adoptedInBatch: number
	}
	private batchCounter = 0

	/**
	 * The step's list, narrowed by any skill scope in force.
	 *
	 * An INTERSECTION, never a replacement: a skill cannot hand the model a
	 * tool the step withheld. Widening has to be unexpressible rather than
	 * discouraged — the same rule `CreateTaskOptions.toolScope` states for
	 * delegation, and for the same reason: a skill file is content, and
	 * content that can grant tools is a privilege-escalation surface wearing
	 * the word "scope".
	 *
	 * The `skill` tool itself always survives. A skill that narrowed the
	 * model out of reaching for another skill would be a one-way door, and
	 * the tool reads instructions and changes nothing.
	 */
	private effectiveAllowedTools(): readonly string[] | undefined {
		const base = this.stepAllowedTools ?? this.config.allowedTools
		const scope = this.skillScope
		if (!scope || scope.adoptedInBatch >= this.batchCounter) return base
		const narrowed = new Set([...scope.allowedTools, SKILL_TOOL_NAME])
		return base === undefined ? [...narrowed] : base.filter((name) => narrowed.has(name))
	}

	private resolvePermissionMode(): PermissionMode {
		const configured = this.config.permissionMode
		return typeof configured === 'function' ? configured() : configured
	}

	/** Evaluate the run's operator policy against one already-prepared value. */
	evaluatePreparedAuthorization(toolName: string, input: unknown) {
		return this.config.authorizationGate?.evaluate({
			toolName,
			toolInput: input,
			toolDef: this.config.tools.get(toolName),
		})
	}

	/**
	 * Resolve repairs and pre-tool hooks, then decode each call exactly once.
	 * The returned projection is what policy and a human review; execution later
	 * consumes the registry-owned preparations rather than parsing again.
	 */
	async prepareBatchForReview(response: ChatCompletionResponse): Promise<PreparedToolBatch> {
		assertUniqueToolCallIds(response.message.toolCalls ?? [])
		const calls = new Map<string, PreparedDirectCall>()
		for (const toolCall of response.message.toolCalls ?? []) {
			calls.set(toolCall.id, await this.prepareDirectCall(toolCall))
		}
		return this.publishPreparedBatch(calls)
	}

	/** Re-prepare only calls whose raw input a reviewer actually changed. */
	async reprepareBatchForReview(
		response: ChatCompletionResponse,
		previous: PreparedToolBatch,
		changedCallIds: ReadonlySet<string>,
	): Promise<PreparedToolBatch> {
		assertUniqueToolCallIds(response.message.toolCalls ?? [])
		if (!this.preparedBatches.has(previous)) {
			throw new Error('Prepared tool batch is not owned by this executor.')
		}
		const calls = new Map((previous as OwnedPreparedToolBatch).calls)
		for (const toolCall of response.message.toolCalls ?? []) {
			if (changedCallIds.has(toolCall.id)) {
				calls.set(toolCall.id, await this.prepareDirectCall(toolCall))
			}
		}
		return this.publishPreparedBatch(calls)
	}

	private publishPreparedBatch(calls: ReadonlyMap<string, PreparedDirectCall>): PreparedToolBatch {
		const reviewCalls = [...calls.values()]
			.filter(
				(call): call is Exclude<PreparedDirectCall, { kind: 'synthetic' }> =>
					call.kind !== 'synthetic',
			)
			.map((call) => ({
				id: call.toolCall.id,
				name: call.toolName,
				input: call.input,
			}))
		const batch: OwnedPreparedToolBatch = Object.freeze({
			reviewCalls: Object.freeze(reviewCalls),
			calls: new Map(calls),
		})
		this.preparedBatches.add(batch)
		return batch
	}

	async executeBatch(
		response: ChatCompletionResponse,
		denials?: ToolCallDenials,
		prior?: PriorToolResults,
		preparedBatch?: PreparedToolBatch,
	): Promise<ToolExecutionBatch> {
		const toolCalls = response.message.toolCalls
		if (!toolCalls) {
			return { messages: [], results: [], observations: [] }
		}
		assertUniqueToolCallIds(toolCalls)

		this.batchCounter += 1

		// Sampled here, once, and held for every call below. See the note on
		// `permissionMode` in the config type.
		this.batchMode = this.resolvePermissionMode()
		try {
			const owned = preparedBatch as OwnedPreparedToolBatch | undefined
			if (owned && !this.preparedBatches.has(owned)) {
				throw new Error('Prepared tool batch is not owned by this executor.')
			}
			return await this.runBatch(toolCalls, denials, prior, owned)
		} finally {
			// Cleared so a later single execution outside a batch resolves
			// live rather than inheriting the last batch's sample.
			this.batchMode = undefined
		}
	}

	private async runBatch(
		toolCalls: readonly ToolCall[],
		denials?: ToolCallDenials,
		prior?: PriorToolResults,
		preparedBatch?: OwnedPreparedToolBatch,
	): Promise<ToolExecutionBatch> {
		this.log.debug('Executing tool batch', {
			[NAMZU.RUN_ID]: this.config.runId,
			'namzu.runtime.tool_count': toolCalls.length,
			'namzu.runtime.denied_count': denials?.size ?? 0,
			'namzu.runtime.recovered_count': prior?.size ?? 0,
			'namzu.tool.names': toolCalls.map((tc) => tc.function.name),
		})

		// One context per call so each execution can see its own
		// `toolUseId`. The base context is built once; we spread + add
		// per-call to keep allocations cheap.
		const observations: ToolResultObservation[] = []
		const recordObservation = (observation: ToolResultObservation): void => {
			observations.push(observation)
		}
		const baseContext = this.buildToolContext(recordObservation)

		// Respect each tool's `concurrencySafe` flag. Read-only tools
		// (ls/grep/glob/…) run in parallel; tools that mutate shared state
		// (edit/write/bash — `concurrencySafe: false`) are serialized in
		// a single chain, so e.g. several `edit` calls to the SAME file in one
		// turn apply one-after-another instead of racing read→modify→write
		// (which let the last writer clobber the rest). Results are written by
		// index to preserve the original tool-call order.
		const results: ToolCallOutcome[] = new Array(toolCalls.length)
		const parallel: Promise<void>[] = []
		let serial: Promise<void> = Promise.resolve()
		// Bounded fan-out. A model emitting fifty parallel reads used to open
		// fifty file handles and fifty activity records simultaneously; the
		// gate keeps that at a working-set size while preserving completion
		// order independence.
		const gate = new Semaphore(this.config.maxToolConcurrency ?? DEFAULT_TOOL_CONCURRENCY)
		toolCalls.forEach((toolCall, i) => {
			const preparedCall = preparedBatch?.calls.get(toolCall.id)
			const recovered = prior?.get(toolCall.id)
			if (recovered !== undefined) {
				// This call already ran, in a process that died before the
				// batch settled. Re-running it would be a second charge, a
				// second email, a second row deleted — so the recorded result
				// answers the `tool_use` block and the tool is not touched.
				results[i] = {
					toolCallId: toolCall.id,
					toolName: toolCall.function.name,
					output: recovered.result,
					isError: recovered.isError,
				}
				return
			}

			const denialReason = denials?.get(toolCall.id)
			if (denialReason !== undefined) {
				// Denied calls never touch the tool; they still get a result
				// message so the assistant turn stays fully answered. Run them
				// on the parallel branch — they perform no side effects, so
				// serialization would only add latency.
				parallel.push(
					this.recordDenial(toolCall, denialReason, preparedCall).then((r) => {
						results[i] = r
					}),
				)
				return
			}
			// Per-call, because the event has to name which call it is about:
			// a batch can run several tools at once and a host rendering them
			// side by side needs to know whose progress this is.
			const progress = new ToolProgressPublisher(this.emitEvent, {
				type: 'tool_progress',
				runId: this.config.runId,
				toolUseId: toolCall.id as ToolUseId,
				toolName: toolCall.function.name,
			})
			const ctx: ToolContext = {
				...baseContext,
				toolUseId: toolCall.id,
				source: { kind: 'direct' },
				// Overridden per call, so a nested dispatch can name the call
				// that made it. The base context has no `toolUseId`, and a
				// closure built there would report every nested call as
				// parentless.
				dispatchTool: (name, input, options) =>
					this.dispatchNested(name, input, ctx, recordObservation, toolCall.function.name, options),
				// Per-call for the same reason: a pause has to be routed back
				// to the call that raised it, and a batch can raise several.
				...(this.config.toolPause ? { requestPause: this.config.toolPause(toolCall.id) } : {}),
				report: (message: string, fraction?: number) => progress.report(message, fraction),
			}
			const run = async () => {
				try {
					results[i] = await this.executeSingle(
						toolCall,
						ctx,
						recordObservation,
						() => progress.close(),
						preparedCall,
					)
				} finally {
					await progress.close()
				}
			}
			const gated = async () => {
				await gate.acquire()
				try {
					await run()
				} finally {
					gate.release()
				}
			}
			let input: unknown = preparedCall?.input ?? {}
			try {
				if (!preparedBatch?.calls.has(toolCall.id)) {
					input = JSON.parse(toolCall.function.arguments || '{}')
				}
			} catch {
				// non-JSON args → treat as unsafe (serialize), the conservative path
			}
			const preparedToolName = preparedCall?.toolName
			const safe =
				this.config.tools
					.get(preparedToolName ?? toolCall.function.name)
					?.isConcurrencySafe?.(input) === true
			if (safe) parallel.push(gated())
			else serial = serial.then(run)
		})
		await Promise.all([...parallel, serial])

		// Whatever failed above left a hole in `results`; fill every one, so
		// the invariant holds by construction rather than by everything having
		// gone well.
		for (let i = 0; i < toolCalls.length; i++) {
			if (results[i]) continue
			const toolCall = toolCalls[i] as ToolCall
			const toolName = toolCall.function.name
			const message = `Error: Tool "${toolName}" did not complete — the batch failed before it produced a result.`
			results[i] = {
				toolCallId: toolCall.id,
				toolName,
				output: message,
				isError: true,
			}
			await this.emitEvent({
				type: 'tool_completed',
				runId: this.config.runId,
				toolUseId: toolCall.id,
				toolName,
				result: message,
				isError: true,
			})
		}

		// isError and rich content were computed and then discarded here: the
		// tuple narrowed to {toolCallId, output} BEFORE the message was built,
		// so the failure signal and any image block were structurally lost at
		// the last possible moment.
		const messages: Message[] = results.map((r) =>
			createToolMessage(r.content ?? r.output, r.toolCallId, r.isError),
		)

		return { messages, results, observations }
	}

	/**
	 * Run a tool on behalf of another tool, and put it on the record.
	 *
	 * These used to go straight to `registry.execute`, so they reached the
	 * permission gate and reached the event stream not at all — a run whose
	 * transcript showed one `run_code` call and nothing about the eleven
	 * writes it performed is a transcript nobody can audit.
	 *
	 * `via` names the dispatching call rather than merely marking this one
	 * nested, and that is the load-bearing part: without it a consumer
	 * counting tool calls double-counts the parent AND each child, and one
	 * rendering a timeline draws eleven siblings where there is one call with
	 * eleven children.
	 */
	private async dispatchNested(
		name: string,
		input: unknown,
		context: ToolContext,
		recordObservation: (observation: ToolResultObservation) => void,
		parentToolName?: string,
		options?: ToolDispatchOptions,
	): Promise<ToolResult> {
		const signal = options?.signal
			? AbortSignal.any([context.abortSignal, options.signal])
			: context.abortSignal
		// Authority is checked before an id, activity or event is created. A
		// retained closure must be observationally inert after its invocation
		// ends, not merely unable to finish the registry call it already started.
		signal.throwIfAborted()
		const preparedCall = await this.prepareNestedCall(name, input, signal)
		signal.throwIfAborted()
		const preparedInput = preparedCall.input

		const parent = context.toolUseId
		const via =
			parent && parentToolName
				? {
						tool: parentToolName,
						toolUseId: parent as ToolUseId,
						...(options?.runtimeToolCallId ? { runtimeToolCallId: options.runtimeToolCallId } : {}),
					}
				: undefined
		// Its own id, minted here. Reusing the parent's would make two
		// different calls indistinguishable in any log keyed by it, which is
		// exactly how a nested write gets attributed to the program that ran
		// it rather than to itself.
		const nestedId = generateToolCallId() as unknown as ToolUseId
		const startedAt = Date.now()
		const source = parent
			? options?.runtimeToolCallId
				? {
						kind: 'code' as const,
						parentToolUseId: parent,
						runtimeToolCallId: options.runtimeToolCallId,
					}
				: { kind: 'nested' as const, parentToolUseId: parent }
			: { kind: 'direct' as const }
		const progress = new ToolProgressPublisher(this.emitEvent, {
			type: 'tool_progress',
			runId: this.config.runId,
			toolUseId: nestedId,
			toolName: name,
		})
		if (preparedCall.kind === 'synthetic') {
			await this.emitEvent({
				type: 'tool_executing',
				runId: this.config.runId,
				toolUseId: nestedId,
				toolName: name,
				input: preparedInput,
				...(via ? { via } : {}),
			})
			await progress.close()
			await this.emitEvent({
				type: 'tool_completed',
				runId: this.config.runId,
				toolUseId: nestedId,
				toolName: name,
				result: preparedCall.message,
				isError: preparedCall.isError,
				durationMs: Date.now() - startedAt,
				outputLength: preparedCall.message.length,
				...(via ? { via } : {}),
			})
			return preparedCall.isError
				? { success: false, output: '', error: preparedCall.message }
				: { success: true, output: preparedCall.message }
		}

		const gateResult = this.config.authorizationGate?.evaluate({
			toolName: name,
			toolInput: preparedInput,
			toolDef: this.config.tools.get(name),
		})
		if (gateResult && gateResult.decision !== 'allow') {
			const reason =
				gateResult.decision === 'deny'
					? `Blocked by the authorization gate: ${gateResult.reason}`
					: `Blocked by the authorization gate: this nested call requires an explicit allow rule because an operator review cannot be opened from inside another tool. ${gateResult.reason}`
			const output = deniedToolOutput(name, reason)
			// Same fail-closed durability rule as a direct gate denial: if the
			// configured run store cannot record the refusal, do not quietly carry
			// on with an unaudited execution.
			if (!this.config.recordAudit) {
				throw new Error(
					`Nested tool "${name}" was refused, but no durable audit recorder is configured.`,
				)
			}
			await this.config.recordAudit({
				what: { action: 'tool_call', tool: name },
				outcome: 'refused',
				reason,
			})
			await progress.close()
			await this.emitEvent({
				type: 'tool_executing',
				runId: this.config.runId,
				toolUseId: nestedId,
				toolName: name,
				input: preparedInput,
				...(via ? { via } : {}),
			})
			await this.emitEvent({
				type: 'tool_completed',
				runId: this.config.runId,
				toolUseId: nestedId,
				toolName: name,
				result: output,
				isError: true,
				durationMs: Date.now() - startedAt,
				outputLength: output.length,
				...(via ? { via } : {}),
			})
			return { success: false, output: '', error: reason }
		}

		const childContext: ToolContext = {
			...context,
			abortSignal: signal,
			toolUseId: nestedId,
			source,
			dispatchTool: (childName, childInput, childOptions) =>
				this.dispatchNested(
					childName,
					childInput,
					childContext,
					recordObservation,
					name,
					childOptions,
				),
			// A nested execution has its own event/progress identity, but its
			// durable pause belongs to the nearest model-issued ancestor. The
			// checkpoint transcript contains that ancestor call and not this
			// ephemeral child id; minting a pause route for `nestedId` makes the
			// answer impossible to match after process restart. `...context`
			// intentionally preserves the ancestor route here.
			report: (message: string, fraction?: number) => progress.report(message, fraction),
		}

		await this.emitEvent({
			type: 'tool_executing',
			runId: this.config.runId,
			toolUseId: nestedId,
			toolName: name,
			input: preparedInput,
			...(via ? { via } : {}),
		})

		const vetoOutcome = this.probes.queryVeto(
			{
				type: 'tool_executing',
				runId: this.config.runId,
				toolUseId: nestedId,
				toolName: name,
				input: preparedInput,
				...(via ? { via } : {}),
			},
			buildProbeContext({ runId: this.config.runId }),
		)
		if (vetoOutcome.action === 'deny') {
			const probeName = vetoOutcome.probeName ?? 'unnamed'
			const reason = vetoOutcome.reason ?? 'no reason provided'
			const message = new ProbeVetoError(probeName, reason, 'tool_executing').message
			await progress.close()
			await this.emitEvent({
				type: 'tool_completed',
				runId: this.config.runId,
				toolUseId: nestedId,
				toolName: name,
				result: `Error: ${message}`,
				isError: true,
				durationMs: Date.now() - startedAt,
				outputLength: message.length + 7,
				...(via ? { via } : {}),
			})
			return { success: false, output: '', error: message }
		}

		let result: ToolResult
		try {
			// Use the same deadline layer as a model-issued call. Calling the
			// registry directly made nested tools the only tools whose own
			// `timeoutMs` declaration was ignored.
			result = await this.runOnce(
				name,
				preparedInput,
				childContext,
				preparedCall.kind === 'ready' ? preparedCall.prepared : undefined,
			)
		} finally {
			await progress.close()
		}

		const rawOutput = result.success
			? result.output
			: formatFailedToolOutput(result.output, result.error)
		const budgeted = applyToolOutputBudget({
			toolName: name,
			toolUseId: nestedId,
			output: rawOutput,
			maxChars: this.config.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS,
			spillDir: this.config.toolOutputDir,
			onError: (message) =>
				this.log.warn('Failed to spill oversized nested tool output', {
					[NAMZU.RUN_ID]: this.config.runId,
					[GENAI.TOOL_NAME]: name,
					'exception.message': message,
				}),
		})
		const visibleResult: ToolResult = result.success
			? { ...result, output: budgeted.output }
			: {
					...result,
					output: '',
					// `run_code` sends `error`, not `output`, across the worker
					// bridge on a failed host call. Leaving the raw error here would
					// make the success path bounded and the failure path unbounded.
					error: budgeted.output,
				}

		await this.emitEvent({
			type: 'tool_completed',
			runId: this.config.runId,
			toolUseId: nestedId,
			toolName: name,
			result: budgeted.output,
			isError: !result.success,
			durationMs: Date.now() - startedAt,
			outputLength: budgeted.originalLength,
			...(budgeted.truncated ? { outputTruncated: true } : {}),
			...(budgeted.spillPath ? { outputSpillPath: budgeted.spillPath } : {}),
			...(via ? { via } : {}),
		})
		recordObservation({
			runId: this.config.runId,
			toolUseId: nestedId,
			toolName: name,
			input: preparedInput,
			result,
			...(parent ? { parentToolUseId: parent } : {}),
		})

		return visibleResult
	}

	private buildToolContext(
		recordObservation: (observation: ToolResultObservation) => void = () => {},
	): ToolContext {
		const context: ToolContext = {
			runId: this.config.runId,
			workingDirectory: this.config.workingDirectory,
			abortSignal: this.config.abortSignal,
			env: this.config.env,
			log: (level, message) => this.log[level](message),
			permissionContext: {
				mode: this.batchMode ?? this.resolvePermissionMode(),
				runId: this.config.runId,
				workingDirectory: this.config.workingDirectory,
			},
			invocationState: this.config.invocationState,
			toolRegistry: this.config.tools,
			// The step's list wins where it has one; the run's is the default.
			// Same precedence the request already uses when it decides which
			// schemas to send, so the menu and the kitchen agree.
			allowedTools: this.effectiveAllowedTools(),
			// Recorded, not applied here: a skill loaded during this batch
			// narrows the NEXT one. See `skillScope`.
			adoptSkillScope: (scope) => {
				this.skillScope = { ...scope, adoptedInBatch: this.batchCounter }
			},
			maxToolOutputChars: this.config.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS,
			...(this.config.skills ? { skills: this.config.skills } : {}),
			...(this.config.web ? { web: this.config.web } : {}),
			// The SAME registry and the SAME context a model-issued call
			// takes. Not a parallel path: a second dispatch is a second place
			// for the permission gate to be forgotten, and the one that forgot
			// it would be the one a model reached through a program.
			// Bound to the BASE context, which has no `toolUseId` — a caller
			// dispatching outside a batch has no parent call to name. The
			// per-call context below overrides it with one that does; see
			// `dispatchNested`.
			dispatchTool: (name, input, options) =>
				this.dispatchNested(name, input, context, recordObservation, undefined, options),
			sandbox: this.config.sandbox,
			fileReadTracker: this.fileReadTracker,
			// Bound to this run, once. Binding here rather than passing the
			// owner from the tool is what makes the scoping structural: there
			// is no argument a tool could pass to reach another run's jobs.
			//
			// The registry's process substrate is the HOST. It must not coexist
			// with a Sandbox in one tool context: handing both to every tool lets
			// any of them call `backgroundJobs.start()` and escape the boundary
			// that its foreground work would use. A sandbox-aware persistent
			// process capability needs its own execution seam; until one exists,
			// the safe composition is to withhold this host capability entirely.
			...(this.config.backgroundJobs && !this.config.sandbox
				? {
						backgroundJobs: bindOwner(this.config.backgroundJobs, this.config.runId, {
							workingDirectory: this.config.workingDirectory,
							env: this.config.env,
						}),
					}
				: {}),
			...(this.parentSpan ? { parentSpan: this.parentSpan } : {}),
		}
		return context
	}

	private async executeSingle(
		toolCall: ToolCall,
		toolContext: ToolContext,
		recordObservation: (observation: ToolResultObservation) => void,
		settleProgress: () => Promise<void>,
		preparedCall?: PreparedDirectCall,
	): Promise<ToolCallOutcome> {
		if (preparedCall?.kind === 'synthetic') {
			return this.recordSyntheticPreparation(preparedCall)
		}

		let toolName = preparedCall?.toolName ?? toolCall.function.name
		let input: unknown
		let prepared: PreparedToolExecution | undefined

		if (preparedCall?.kind === 'ready' || preparedCall?.kind === 'legacy') {
			input = preparedCall.input
			prepared = preparedCall.kind === 'ready' ? preparedCall.prepared : undefined
		} else {
			// A stream that cut off mid-JSON is the case `repairToolCall` exists
			// for, and it used to be the one case that never reached it: this
			// branch returned before `resolveCall` ran, so the motivating failure
			// was answered with a generic hint while the configured repairer sat
			// unused. Offer it the partial buffer first.
			const truncationRepair =
				toolCall.metadata?.inputTruncated === true
					? await this.repairTruncatedCall(toolCall, toolName)
					: null

			if (toolCall.metadata?.inputTruncated === true && !truncationRepair) {
				const message = truncatedToolInputMessage(toolName)
				await this.emitEvent({
					type: 'tool_executing',
					runId: this.config.runId,
					toolUseId: toolCall.id,
					toolName,
					input: {},
				})
				await this.emitEvent({
					type: 'tool_completed',
					runId: this.config.runId,
					toolUseId: toolCall.id,
					toolName,
					result: message,
					isError: true,
				})
				return {
					toolCallId: toolCall.id,
					toolName,
					output: message,
					isError: true,
				}
			}

			// A malformed call used to cost a full model round trip to fix: the
			// error went back as a `tool_result`, the model re-read the whole
			// context and tried again. A host that can repair it locally turns
			// that into nothing. No-op when no repairer is configured.
			const resolved = await this.resolveCall(
				truncationRepair
					? {
							...toolCall,
							function: {
								...toolCall.function,
								name: truncationRepair.toolName ?? toolName,
								arguments: truncationRepair.arguments,
							},
							metadata: {},
						}
					: toolCall,
			)
			toolName = resolved.toolName

			if (!resolved.ok) {
				// malformed JSON args used to return without ever
				// emitting tool_executing or tool_completed, leaving UI cards
				// orphaned in `streaming_input`. Emit the executing→completed
				// terminal pair so the card lifecycle closes.
				const message = resolved.message
				await this.emitEvent({
					type: 'tool_executing',
					runId: this.config.runId,
					toolUseId: toolCall.id,
					toolName,
					input: {},
				})
				await this.emitEvent({
					type: 'tool_completed',
					runId: this.config.runId,
					toolUseId: toolCall.id,
					toolName,
					result: message,
					isError: true,
				})
				return {
					toolCallId: toolCall.id,
					toolName,
					output: message,
					isError: true,
				}
			}

			input = resolved.input

			const preOutcome = await this.runPreToolHook(toolName, input)
			if (preOutcome.kind === 'skip' || preOutcome.kind === 'error') {
				return this.recordSyntheticHookOutcome(toolCall.id, toolName, preOutcome.input, preOutcome)
			}
			input = preOutcome.input
		}

		const activity = this.activityStore.create({
			type: 'tool_call',
			description: toolName,
			input,
			toolName,
			toolCallId: toolCall.id,
		})
		if (activity) {
			this.activityStore.start(activity.id)
		}

		await this.emitEvent({
			type: 'tool_executing',
			runId: this.config.runId,
			toolUseId: toolCall.id,
			toolName,
			input,
		})

		const vetoOutcome = this.probes.queryVeto(
			{
				type: 'tool_executing',
				runId: this.config.runId,
				toolUseId: toolCall.id,
				toolName,
				input,
			},
			buildProbeContext({ runId: this.config.runId }),
		)
		if (vetoOutcome.action === 'deny') {
			const probeName = vetoOutcome.probeName ?? 'unnamed'
			const reason = vetoOutcome.reason ?? 'no reason provided'
			const veto = new ProbeVetoError(probeName, reason, 'tool_executing')
			this.log.warn('Tool call denied by probe', {
				[NAMZU.RUN_ID]: this.config.runId,
				[GENAI.TOOL_NAME]: toolName,
				'namzu.runtime.probe_name': probeName,
				'namzu.runtime.reason': reason,
			})
			if (activity) {
				this.activityStore.fail(activity.id, veto.message)
			}
			// probe veto used to skip tool_completed entirely.
			// Emit the terminal event with isError so UI cards finalize.
			await this.emitEvent({
				type: 'tool_completed',
				runId: this.config.runId,
				toolUseId: toolCall.id,
				toolName,
				result: `Error: ${veto.message}`,
				isError: true,
			})
			return {
				toolCallId: toolCall.id,
				toolName,
				output: `Error: ${veto.message}`,
				// The event emitted just above says this failed; the RESULT
				// has to say so too. This was the only result-producing
				// branch in the file that left it off, and `isError` being
				// optional meant the compiler could not notice.
				//
				// Four things degraded off the omission, not one. Two drivers
				// emit their failure marker only when this is true, so the
				// model read a SUCCESSFUL result whose body begins "Error: …"
				// and the failure-recovery path it was trained on never
				// fired. The persisted step recorded a literal
				// `isError: false`, so the run record contradicted its own
				// event stream. And compaction's guard against clearing error
				// results silently excluded vetoed ones.
				isError: true,
			}
		}

		if (this.workingStateManager) {
			extractFromToolCall(this.workingStateManager, toolName, JSON.stringify(input))
		}

		const startMs = Date.now()
		// an unhandled throw from `tools.execute(...)` used to
		// propagate up to `result.ts` as `run_failed` without emitting a
		// terminal `tool_completed`, leaving UI cards stuck in `executing`.
		// Wrap so any throw materialises as an error result.
		// Typed as the full ToolResult, not a narrowed literal: the narrow
		// version silently DROPPED `content`, so a tool returning an image
		// block had it discarded here — before the wire mapper that was
		// built to carry it ever saw it.
		let result: ToolResult = await this.runOnce(toolName, input, toolContext, prepared)
		let post = await this.runPostToolHook(toolName, input, result)

		// In-loop retry. A transient failure used to cost a full model round
		// trip: the error went back as a `tool_result`, the model read it and
		// decided (or didn't) to call again. Strictly opt-in per tool,
		// because the SDK cannot know a tool is idempotent — silently
		// re-running a write or a payment is worse than never retrying.
		const maxRetries = Math.max(0, this.config.tools.get(toolName)?.maxRetries ?? 0)
		const backoff: BackoffPolicy = {
			...DEFAULT_TOOL_RETRY_BACKOFF,
			...this.config.toolRetryBackoff,
		}
		for (let attempt = 1; ; attempt++) {
			// A missing file will not appear on the second attempt; burning
			// the budget on it only delays the error the model needs to see.
			const toolWants = !result.success && result.retryable === true
			// A `post_tool_use` hook asking for a retry gets its OWN budget.
			// Bounding it by `maxRetries` made it a silent no-op at the
			// shipped default of 0: the hook's answer was read and discarded
			// on every tool that had not separately opted in. The hook is
			// host code looking at this specific result — a more specific
			// signal than the tool's blanket idempotency declaration — so it
			// is honored, but still bounded so a plugin cannot spin the
			// executor.
			if (!toolWants && !post.retry) break
			const budget = post.retry ? Math.max(maxRetries, HOOK_RETRY_BUDGET) : maxRetries
			if (attempt > budget) break

			// Wait before trying again, on the curve the provider path has
			// used all along. This loop had NO delay: a tool failing on a
			// transient condition — a rate-limited HTTP call, a lock, a cold
			// connection — was re-run immediately, several times, which is the
			// pattern most likely to prolong the very condition it is retrying
			// against.
			//
			// Full jitter rather than a fixed wait, and the concurrency that
			// makes it matter is one this loop creates itself: a model emits a
			// batch of parallel calls, `executeBatch` runs up to
			// DEFAULT_TOOL_CONCURRENCY of them at once, they hit the same
			// rate-limited endpoint and fail together. A fixed backoff would
			// resynchronise that batch on every attempt.
			//
			// `attempt` is 1-based here and `backoffWithJitter` is 0-based, so
			// the first retry draws from `[0, initialDelayMs]`.
			const delayMs = backoffWithJitter(attempt - 1, backoff)

			this.log.info('Retrying a failed tool call', {
				[NAMZU.RUN_ID]: this.config.runId,
				[GENAI.TOOL_NAME]: toolName,
				'namzu.retry.attempt': attempt,
				'namzu.runtime.budget': budget,
				'namzu.runtime.requested_by_hook': post.retry,
				'namzu.runtime.delay_ms': delayMs,
				'exception.message': result.error,
			})

			try {
				await sleep(delayMs, this.config.abortSignal)
			} catch {
				// Stopped mid-backoff. Give up retrying and let the failure
				// already in `result` be this call's answer, rather than
				// throwing: every `tool_use` must be answered by a
				// `tool_result` with the same id, and an abort escaping from
				// here would leave this one open in the transcript for a
				// resume to trip over.
				break
			}

			result = await this.runOnce(toolName, input, toolContext, prepared)
			post = await this.runPostToolHook(toolName, input, result)
		}
		const durationMs = Date.now() - startMs

		const rawOutput = result.success
			? result.output
			: formatFailedToolOutput(result.output, result.error)

		const postOverride = post.override
		let output =
			postOverride?.output ?? (result.success ? this.maybeCompress(toolName, rawOutput) : rawOutput)
		const selectedContent = postOverride?.isError
			? undefined
			: (postOverride?.content ?? result.content)
		const maxToolOutputChars = this.config.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS

		// If the text preview forces rich content out, say so inside the SAME
		// budget. Appending this after truncation made the diagnostic itself a
		// cap bypass; selecting a post-hook override after truncation was a
		// larger bypass that could replace a bounded result with anything.
		if (
			maxToolOutputChars > 0 &&
			output.length > maxToolOutputChars &&
			selectedContent !== undefined
		) {
			const dropped = describeDroppedContent(selectedContent)
			if (dropped) output = `${output}\n\n${dropped}`
		}

		// Compression is opportunistic and shell-only; the budget is the
		// hard bound that applies to every final tool result, including a
		// post-tool hook's replacement and the rich-content omission notice.
		const budgeted = applyToolOutputBudget({
			toolName,
			toolUseId: toolCall.id,
			output,
			maxChars: maxToolOutputChars,
			spillDir: this.config.toolOutputDir,
			onError: (message) =>
				this.log.warn('Failed to spill oversized tool output', {
					[NAMZU.RUN_ID]: this.config.runId,
					[GENAI.TOOL_NAME]: toolName,
					'exception.message': message,
				}),
		})
		if (budgeted.truncated) {
			this.log.warn('Tool output exceeded the model-visible budget', {
				[NAMZU.RUN_ID]: this.config.runId,
				[GENAI.TOOL_NAME]: toolName,
				'namzu.runtime.original_length': budgeted.originalLength,
				'namzu.runtime.spill_path': budgeted.spillPath,
			})
		}
		output = budgeted.output

		// A failed call, or an override that says the call failed. A `replace`
		// says the opposite, and reading it as a failure is what made redaction
		// unusable: the model was told a successful call had gone wrong, and
		// routed around it.
		const effectiveIsError = !result.success || (postOverride?.isError ?? false)

		if (this.workingStateManager) {
			extractFromToolResult(this.workingStateManager, toolName, output, effectiveIsError)
		}

		if (result.success) {
			this.log.debug('Tool executed successfully', {
				[NAMZU.RUN_ID]: this.config.runId,
				[GENAI.TOOL_NAME]: toolName,
				'namzu.duration_ms': durationMs,
				'namzu.runtime.output_length': output.length,
			})
		} else {
			this.log.warn('Tool execution failed', {
				[NAMZU.RUN_ID]: this.config.runId,
				[GENAI.TOOL_NAME]: toolName,
				'namzu.duration_ms': durationMs,
				'exception.message': result.error ?? 'unknown',
			})
		}

		if (activity) {
			if (effectiveIsError) {
				this.activityStore.fail(activity.id, output)
			} else {
				this.activityStore.complete(activity.id, output)
			}
		}

		// The terminal event closes the live row. Every accepted progress update
		// must settle before it, otherwise a slow host can receive an update for a
		// call it has already removed. Detached work reporting after a timeout is
		// ignored because close() also revokes the publisher.
		await settleProgress()
		await this.emitEvent({
			type: 'tool_completed',
			runId: this.config.runId,
			toolUseId: toolCall.id,
			toolName,
			result: output,
			isError: effectiveIsError,
			durationMs,
			// Pre-truncation size, so a host can show "returned 2.1 MB" even
			// though the model only ever saw a preview.
			outputLength: budgeted.originalLength,
			...(budgeted.truncated ? { outputTruncated: true } : {}),
			...(budgeted.spillPath ? { outputSpillPath: budgeted.spillPath } : {}),
		})
		recordObservation({
			runId: this.config.runId,
			toolUseId: toolCall.id,
			toolName,
			input,
			result,
		})

		const resolveContent = (): { content?: ToolResultContent } => {
			if (budgeted.truncated || selectedContent === undefined) return {}
			return { content: this.budgetContent(selectedContent, toolName) }
		}

		return {
			toolCallId: toolCall.id,
			toolName,
			output,
			isError: effectiveIsError,
			// Rich content follows the override's own decision.
			//
			// An ERROR override drops it: the payload is no longer the tool's,
			// and shipping an image beside a failure message describes something
			// the model was just told did not happen. A spilled preview drops it
			// for the same reason.
			//
			// A REPLACE keeps it, because the common case is redacting text from
			// a result whose image is unaffected — and a hook that needs it gone
			// says so with `content`, which wins over both.
			...resolveContent(),
		}
	}

	/**
	 * Run a tool under a deadline, with the run abort folded in.
	 *
	 * `ToolContext.abortSignal` existed but was produced and consumed by
	 * nothing: a Stop tore down the model stream and then parked inside
	 * `Promise.all` waiting for a tool that had no idea it should quit. A
	 * hung MCP stdio server or a `bash` with the old one-hour default
	 * could hold a turn open long after the user cancelled.
	 *
	 * Two mechanisms, because neither alone is enough:
	 *
	 * 1. The composed signal (run abort OR deadline) is handed to the tool
	 *    so a cooperative tool actually stops working.
	 * 2. The `race` bounds the *executor's* wait regardless, so an
	 *    uncooperative tool becomes detached rather than blocking.
	 *
	 * A timeout is reported as a normal failed result, not a throw: the
	 * model sees "this timed out" as a `tool_result` and can route around
	 * it. A throw would end the run over one slow tool.
	 */
	private async executeWithDeadline(
		toolName: string,
		input: unknown,
		toolContext: ToolContext,
		prepared?: PreparedToolExecution,
	): Promise<ToolResult> {
		const timeoutMs =
			this.config.tools.get(toolName)?.timeoutMs ??
			this.config.toolTimeoutMs ??
			DEFAULT_TOOL_TIMEOUT_MS

		const controller = new AbortController()
		const parentSignal = toolContext.abortSignal
		const onParentAbort = () => controller.abort(parentSignal.reason)
		if (parentSignal.aborted) controller.abort(parentSignal.reason)
		else parentSignal.addEventListener('abort', onParentAbort, { once: true })

		let timer: ReturnType<typeof setTimeout> | undefined
		let timedOut = false
		let invocationOpen = true
		const nestedDispatches = new Set<Promise<ToolResult>>()

		try {
			const expired =
				Number.isFinite(timeoutMs) && timeoutMs > 0
					? new Promise<'timeout'>((resolve) => {
							timer = setTimeout(() => {
								timedOut = true
								controller.abort(new Error(`Tool "${toolName}" exceeded ${timeoutMs}ms`))
								resolve('timeout')
							}, timeoutMs)
						})
					: undefined

			const aborted = new Promise<'aborted'>((resolve) => {
				if (controller.signal.aborted && !timedOut) {
					resolve('aborted')
					return
				}
				controller.signal.addEventListener(
					'abort',
					() => {
						if (!timedOut) resolve('aborted')
					},
					{ once: true },
				)
			})

			const inheritedDispatch = toolContext.dispatchTool
			const scopedDispatch = inheritedDispatch
				? (name: string, nestedInput: unknown, options?: ToolDispatchOptions) => {
						if (!invocationOpen) {
							return Promise.reject(
								new Error(`Tool "${toolName}" invocation has settled; nested dispatch is closed.`),
							)
						}
						const nested = inheritedDispatch(name, nestedInput, {
							...options,
							signal: options?.signal
								? AbortSignal.any([controller.signal, options.signal])
								: controller.signal,
						})
						nestedDispatches.add(nested)
						// `finally()` creates a second promise. Observe that promise too, or a
						// rejected nested call which its owner intentionally awaits later would
						// also create an unhandled cleanup rejection here.
						void nested.finally(() => nestedDispatches.delete(nested)).catch(() => {})
						return nested
					}
				: undefined

			if (controller.signal.aborted) {
				return {
					success: false,
					output: '',
					error: abortReasonText(controller.signal.reason)
						? `Tool "${toolName}" was cancelled: ${abortReasonText(controller.signal.reason)}`
						: `Tool "${toolName}" was cancelled.`,
				}
			}

			const context = {
				...toolContext,
				abortSignal: controller.signal,
				...(scopedDispatch ? { dispatchTool: scopedDispatch } : {}),
			}
			const execution = prepared
				? this.config.tools.executePrepared(prepared, context)
				: this.config.tools.execute(toolName, input, context)
			// The loser of the race may still reject later; neutralize it so
			// it is never an unhandled rejection.
			execution.catch(() => {})

			const outcome = await Promise.race(
				expired ? [execution, expired, aborted] : [execution, aborted],
			)

			if (outcome === 'timeout') {
				this.log.warn('Tool timed out', {
					[NAMZU.RUN_ID]: this.config.runId,
					[GENAI.TOOL_NAME]: toolName,
					'namzu.runtime.timeout_ms': timeoutMs,
				})
				return {
					success: false,
					output: '',
					error: `Tool "${toolName}" timed out after ${timeoutMs}ms and was abandoned. It may still be running. Try a narrower input, or a different approach.`,
				}
			}

			if (outcome === 'aborted') {
				// Say WHY, when the caller said why. The reason has been
				// available on this signal all along — it is forwarded into
				// `controller` a few lines above — and the message threw it
				// away, so a deadline, a budget and an operator pressing stop
				// were all reported to the model with the same four words.
				// Those want different next moves.
				const why = abortReasonText(controller.signal.reason)
				return {
					success: false,
					output: '',
					error: why
						? `Tool "${toolName}" was cancelled: ${why}`
						: `Tool "${toolName}" was cancelled.`,
				}
			}

			return outcome
		} finally {
			// Revoke synchronously before awaiting anything. A retained closure
			// called from another microtask is refused here; the aborted signal is
			// the structural backstop inside dispatchNested itself.
			invocationOpen = false
			if (!controller.signal.aborted) {
				controller.abort(new Error(`Tool "${toolName}" invocation has settled.`))
			}
			// Calls already admitted before closure own event rows and registry
			// work. Their executor races observe the abort, emit a terminal result,
			// and settle before the parent is allowed to report completion.
			while (nestedDispatches.size > 0) {
				await Promise.allSettled([...nestedDispatches])
			}
			if (timer !== undefined) clearTimeout(timer)
			parentSignal.removeEventListener('abort', onParentAbort)
		}
	}

	private async runPreToolHook(
		toolName: string,
		input: unknown,
		signal: AbortSignal = this.config.abortSignal,
	): Promise<PreToolHookOutcome> {
		if (!this.config.pluginManager) return { kind: 'continue', input, modified: false }
		const results = await this.config.pluginManager.executeHooks(
			'pre_tool_use',
			{
				runId: this.config.runId,
				toolName,
				toolInput: input,
				signal,
			},
			this.emitEvent,
		)
		return this.interpretPreToolResults(toolName, input, results)
	}

	private async prepareNestedCall(
		toolName: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<PreparedNestedCall> {
		const prepare = this.config.tools.prepareExecution
		const executePrepared = this.config.tools.executePrepared
		if (typeof prepare !== 'function' || typeof executePrepared !== 'function') {
			if (this.config.authorizationGate) {
				return {
					kind: 'synthetic',
					input,
					message: `Tool "${toolName}" was not executed because its registry cannot bind authorization to one prepared input.`,
					isError: true,
				}
			}
			const preOutcome = await this.runPreToolHook(toolName, input, signal)
			if (preOutcome.kind === 'skip' || preOutcome.kind === 'error') {
				return {
					kind: 'synthetic',
					input: preOutcome.input,
					message: preOutcome.output,
					isError: preOutcome.kind === 'error',
				}
			}
			return { kind: 'legacy', input: preOutcome.input }
		}

		let preparation: ReturnType<typeof prepare>
		try {
			preparation = prepare.call(this.config.tools, toolName, input)
		} catch (err) {
			return {
				kind: 'synthetic',
				input,
				message: `Tool "${toolName}" could not be prepared: ${toErrorMessage(err)}`,
				isError: true,
			}
		}
		if (!preparation.success) {
			return {
				kind: 'synthetic',
				input,
				message: formatFailedToolOutput(preparation.result.output, preparation.result.error),
				isError: true,
			}
		}
		const preOutcome = await this.runPreToolHook(toolName, preparation.prepared.input, signal)
		if (preOutcome.kind === 'skip' || preOutcome.kind === 'error') {
			return {
				kind: 'synthetic',
				input: preOutcome.input,
				message: preOutcome.output,
				isError: preOutcome.kind === 'error',
			}
		}
		if (!preOutcome.modified) {
			return {
				kind: 'ready',
				input: preparation.prepared.input,
				prepared: preparation.prepared,
			}
		}
		const modified = prepare.call(this.config.tools, toolName, preOutcome.input)
		if (!modified.success) {
			return {
				kind: 'synthetic',
				input: preOutcome.input,
				message: formatFailedToolOutput(modified.result.output, modified.result.error),
				isError: true,
			}
		}
		return { kind: 'ready', input: modified.prepared.input, prepared: modified.prepared }
	}

	private async prepareDirectCall(toolCall: ToolCall): Promise<PreparedDirectCall> {
		let toolName = toolCall.function.name
		const truncationRepair =
			toolCall.metadata?.inputTruncated === true
				? await this.repairTruncatedCall(toolCall, toolName)
				: null
		if (toolCall.metadata?.inputTruncated === true && !truncationRepair) {
			return {
				kind: 'synthetic',
				toolCall,
				toolName,
				input: {},
				message: truncatedToolInputMessage(toolName),
				isError: true,
			}
		}

		const prepare = this.config.tools.prepareExecution
		const executePrepared = this.config.tools.executePrepared
		if (typeof prepare !== 'function' || typeof executePrepared !== 'function') {
			const resolved = await this.resolveCall(
				truncationRepair
					? {
							...toolCall,
							function: {
								...toolCall.function,
								name: truncationRepair.toolName ?? toolName,
								arguments: truncationRepair.arguments,
							},
							metadata: {},
						}
					: toolCall,
			)
			toolName = resolved.toolName
			if (!resolved.ok) {
				return {
					kind: 'synthetic',
					toolCall,
					toolName,
					input: {},
					message: resolved.message,
					isError: true,
				}
			}
			const preOutcome = await this.runPreToolHook(toolName, resolved.input)
			if (preOutcome.kind === 'skip' || preOutcome.kind === 'error') {
				return {
					kind: 'synthetic',
					toolCall,
					toolName,
					input: preOutcome.input,
					message: preOutcome.output,
					isError: preOutcome.kind === 'error',
				}
			}
			if (!this.config.authorizationGate) {
				return {
					kind: 'legacy',
					toolCall,
					toolName,
					input: preOutcome.input,
				}
			}
			return {
				kind: 'synthetic',
				toolCall,
				toolName,
				input: preOutcome.input,
				message: `Tool "${toolName}" was not executed because its registry cannot bind authorization to one prepared input.`,
				isError: true,
			}
		}

		let raw = truncationRepair?.arguments ?? toolCall.function.arguments
		toolName = truncationRepair?.toolName ?? toolName
		let repairUsed = truncationRepair !== null
		let preparation: ReturnType<typeof prepare>
		for (;;) {
			let parsed: unknown
			try {
				parsed = parseArguments(raw)
			} catch {
				const message = `Error: Invalid JSON in tool arguments for "${toolName}"`
				const repair =
					!repairUsed && this.config.repairToolCall
						? await this.requestRepair(toolCall, toolName, {
								reason: 'invalid_json',
								message,
							})
						: null
				if (repair) {
					repairUsed = true
					toolName = repair.toolName ?? toolName
					raw = repair.arguments
					continue
				}
				return { kind: 'synthetic', toolCall, toolName, input: {}, message, isError: true }
			}

			try {
				preparation = prepare.call(this.config.tools, toolName, parsed)
			} catch (err) {
				const message = `Error: Unknown or unavailable tool "${toolName}": ${toErrorMessage(err)}`
				const repair =
					!repairUsed && this.config.repairToolCall
						? await this.requestRepair(toolCall, toolName, {
								reason: 'unknown_tool',
								message,
							})
						: null
				if (repair) {
					repairUsed = true
					toolName = repair.toolName ?? toolName
					raw = repair.arguments
					continue
				}
				return { kind: 'synthetic', toolCall, toolName, input: parsed, message, isError: true }
			}

			if (preparation.success) break
			const message = formatFailedToolOutput(preparation.result.output, preparation.result.error)
			const repair =
				!repairUsed && this.config.repairToolCall
					? await this.requestRepair(toolCall, toolName, {
							reason: 'schema_validation',
							message,
						})
					: null
			if (repair) {
				repairUsed = true
				toolName = repair.toolName ?? toolName
				raw = repair.arguments
				continue
			}
			return {
				kind: 'synthetic',
				toolCall,
				toolName,
				input: parsed,
				message,
				isError: true,
			}
		}

		const preOutcome = await this.runPreToolHook(toolName, preparation.prepared.input)
		if (preOutcome.kind === 'skip' || preOutcome.kind === 'error') {
			return {
				kind: 'synthetic',
				toolCall,
				toolName,
				input: preOutcome.input,
				message: preOutcome.output,
				isError: preOutcome.kind === 'error',
			}
		}

		if (preOutcome.modified) {
			const modified = prepare.call(this.config.tools, toolName, preOutcome.input)
			if (!modified.success) {
				return {
					kind: 'synthetic',
					toolCall,
					toolName,
					input: preOutcome.input,
					message: formatFailedToolOutput(modified.result.output, modified.result.error),
					isError: true,
				}
			}
			preparation = modified
		}

		return {
			kind: 'ready',
			toolCall,
			toolName,
			input: preparation.prepared.input,
			prepared: preparation.prepared,
		}
	}

	private interpretPreToolResults(
		toolName: string,
		initialInput: unknown,
		results: readonly PluginHookResult[],
	): PreToolHookOutcome {
		let currentInput = initialInput
		let modified = false
		for (const result of results) {
			switch (result.action) {
				case 'continue':
					continue
				case 'modify':
					currentInput = result.input
					modified = true
					continue
				case 'skip':
					return {
						kind: 'skip',
						input: currentInput,
						output: `Tool ${toolName} skipped by plugin: ${result.reason}`,
					}
				case 'error':
					return {
						kind: 'error',
						input: currentInput,
						output: `Error: ${result.message}`,
					}
				case 'retry':
				// There is no result to replace yet. Rejecting loudly beats
				// silently ignoring it: a hook author who returned this here
				// meant to redact something and would otherwise watch the secret
				// go through.
				case 'replace':
					throw new Error(
						`Plugin hook pre_tool_use returned unsupported action '${result.action}' for tool ${toolName}`,
					)
				default: {
					const _exhaustive: never = result
					throw new Error(`Unknown PluginHookResult: ${JSON.stringify(_exhaustive)}`)
				}
			}
		}
		return { kind: 'continue', input: currentInput, modified }
	}

	/**
	 * Turn the call the model issued into a name and a parsed input, giving
	 * a configured repairer one chance to fix it first.
	 *
	 * Exactly one chance: a repairer that produces a call which is still
	 * broken will not do better on a second look, and an unbounded loop
	 * here is a hang rather than a degradation.
	 *
	 * `invalid_json` is the ONLY failure that stops the call here, and it
	 * stopped it before this function existed too. `unknown_tool` and
	 * `schema_validation` merely OFFER the repair and otherwise fall
	 * through to the registry, which reports both with better messages —
	 * its schema error already ships a "Required: <field>: <type>" hint the
	 * model can self-correct from. So with no repairer configured this is
	 * behaviorally identical to the bare `JSON.parse` it replaced.
	 */
	private async resolveCall(
		toolCall: ToolCall,
	): Promise<
		| { ok: true; toolName: string; input: unknown }
		| { ok: false; toolName: string; message: string }
	> {
		let toolName = toolCall.function.name
		let raw = toolCall.function.arguments

		for (let attempt = 0; ; attempt++) {
			const failure = this.inspectCall(toolName, raw)
			if (!failure) return { ok: true, toolName, input: parseArguments(raw) }

			const repair =
				attempt === 0 && this.config.repairToolCall
					? await this.requestRepair(toolCall, toolName, failure)
					: null

			if (!repair) {
				if (failure.reason === 'invalid_json') {
					return { ok: false, toolName, message: failure.message }
				}
				return { ok: true, toolName, input: parseArguments(raw) }
			}

			this.log.info('Repaired a malformed tool call', {
				[NAMZU.RUN_ID]: this.config.runId,
				[GENAI.TOOL_NAME]: toolName,
				'namzu.runtime.reason': failure.reason,
				...(repair.toolName && repair.toolName !== toolName
					? { 'namzu.runtime.repaired_to': repair.toolName }
					: {}),
			})
			toolName = repair.toolName ?? toolName
			raw = repair.arguments
		}
	}

	/**
	 * What is wrong with this call, or `null` if nothing is.
	 *
	 * JSON is checked before the tool is looked up: an unparseable argument
	 * string is broken regardless of which tool it was aimed at, and it is
	 * the one problem the executor itself has to answer.
	 */
	private async repairTruncatedCall(
		toolCall: ToolCall,
		toolName: string,
	): Promise<ToolCallRepair | null> {
		if (!this.config.repairToolCall) return null

		// Present the PARTIAL buffer, not the normalized `"{}"` — a repairer
		// handed an empty object has nothing to work from.
		const partial = toolCall.metadata?.partialArguments ?? ''
		const repair = await this.requestRepair(
			{ ...toolCall, function: { ...toolCall.function, arguments: partial } },
			toolName,
			{ reason: 'invalid_json', message: truncatedToolInputMessage(toolName) },
		)
		if (repair) {
			this.log.info('Repaired a tool call whose input stream was truncated', {
				[NAMZU.RUN_ID]: this.config.runId,
				[GENAI.TOOL_NAME]: toolName,
				'namzu.runtime.partial_length': partial.length,
			})
		}
		return repair
	}

	private inspectCall(
		toolName: string,
		raw: string,
	): { reason: ToolCallRepairReason; message: string } | null {
		let parsed: unknown
		try {
			parsed = parseArguments(raw)
		} catch {
			return {
				reason: 'invalid_json',
				message: `Error: Invalid JSON in tool arguments for "${toolName}"`,
			}
		}

		const tool = this.config.tools.get?.(toolName)
		if (!tool) {
			// Either the model named a tool that does not exist, or this
			// registry does not implement `get`. Both are the registry's to
			// answer; a repairer still gets offered the `unknown_tool` case.
			return {
				reason: 'unknown_tool',
				message: `Error: Unknown tool "${toolName}"`,
			}
		}

		// A registry that hands back a tool with no schema has nothing to
		// validate against; that is not a repairable condition, just an
		// unvalidatable one.
		const validation = tool.inputSchema?.safeParse(parsed)
		if (validation && !validation.success) {
			return {
				reason: 'schema_validation',
				message: `Error: Invalid arguments for "${toolName}": ${validation.error.issues
					.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
					.join('; ')}`,
			}
		}

		return null
	}

	private async requestRepair(
		toolCall: ToolCall,
		toolName: string,
		failure: { reason: ToolCallRepairReason; message: string },
	): Promise<ToolCallRepair | null> {
		const repairToolCall = this.config.repairToolCall
		if (!repairToolCall) return null

		const tool = this.config.tools.get(toolName)
		try {
			return await repairToolCall({
				toolCall,
				reason: failure.reason,
				message: failure.message,
				...(tool
					? {
							tool,
							jsonSchema: tool.modelInputSchema ?? renderToolSchema(tool.inputSchema),
						}
					: {}),
				availableTools: this.config.tools.listNames(),
			})
		} catch (err) {
			// A broken repairer must not turn a recoverable tool error into a
			// failed run: the original error is still a perfectly good answer
			// to give the model.
			this.log.error('repairToolCall threw — falling back to the original error', {
				[NAMZU.RUN_ID]: this.config.runId,
				[GENAI.TOOL_NAME]: toolName,
				'exception.message': toErrorMessage(err),
			})
			return null
		}
	}

	/**
	 * One execution attempt, with a throw materialized as an error result.
	 *
	 * an unhandled throw from `tools.execute(...)` used to
	 * propagate up to `result.ts` as `run_failed` without emitting a
	 * terminal `tool_completed`, leaving UI cards stuck in `executing`.
	 *
	 * The return is the full `ToolResult`, not a narrowed literal: the
	 * narrow version silently DROPPED `content`, so a tool returning an
	 * image block had it discarded here — before the wire mapper built to
	 * carry it ever saw it.
	 */
	private async runOnce(
		toolName: string,
		input: unknown,
		toolContext: ToolContext,
		prepared?: PreparedToolExecution,
	): Promise<ToolResult> {
		try {
			return await this.executeWithDeadline(toolName, input, toolContext, prepared)
		} catch (err) {
			const message = toErrorMessage(err)
			this.log.warn('Tool execution threw', {
				[NAMZU.RUN_ID]: this.config.runId,
				[GENAI.TOOL_NAME]: toolName,
				'exception.message': message,
			})
			return { success: false, output: '', error: message }
		}
	}

	/**
	 * @returns `override` — text replacing the tool's output, or `null`.
	 *   `retry` — the hook asked for the tool to run again.
	 */
	private async runPostToolHook(
		toolName: string,
		input: unknown,
		toolResult: ToolResult,
	): Promise<{ override: PostToolOverride | null; retry: boolean }> {
		if (!this.config.pluginManager) return { override: null, retry: false }
		const results = await this.config.pluginManager.executeHooks(
			'post_tool_use',
			{
				runId: this.config.runId,
				toolName,
				toolInput: input,
				toolResult,
				signal: this.config.abortSignal,
			},
			this.emitEvent,
		)
		let override: PostToolOverride | null = null
		let retry = false
		for (const result of results) {
			switch (result.action) {
				case 'continue':
					continue
				case 'error':
					override = { output: `Error: ${result.message}`, isError: true }
					continue
				// A redaction, not a failure. The call stood; the model is shown
				// less of it. Rich content survives unless the hook replaced it —
				// see the variant's own documentation for why that default, and
				// for what a hook redacting a secret in an image has to do.
				case 'replace':
					override = {
						output: result.output,
						isError: false,
						...(result.content !== undefined ? { content: result.content } : {}),
					}
					continue
				// `retry` was a declared variant with no implementation: every
				// site that consumed it threw. Here it finally means something
				// — the hook saw the result and wants the tool run again —
				// and it is bounded by the same per-tool retry budget, so a
				// plugin cannot spin the executor.
				case 'retry':
					retry = true
					continue
				case 'skip':
				case 'modify':
					throw new Error(
						`Plugin hook post_tool_use returned unsupported action '${result.action}' for tool ${toolName}`,
					)
				default: {
					const _exhaustive: never = result
					throw new Error(`Unknown PluginHookResult: ${JSON.stringify(_exhaustive)}`)
				}
			}
		}
		return { override, retry }
	}

	/**
	 * Answer a tool call that policy or a human refused, without executing
	 * it. Emits the same `tool_executing` → `tool_completed` pair as a real
	 * execution so UI cards reach a terminal state instead of hanging in
	 * `executing`, and records a failed activity for the trace.
	 */
	private async recordDenial(
		toolCall: ToolCall,
		reason: string,
		preparedCall?: PreparedDirectCall,
	): Promise<ToolCallOutcome> {
		const toolName = preparedCall?.toolName ?? toolCall.function.name
		let input: unknown = preparedCall?.input ?? {}
		if (!preparedCall) {
			try {
				input = JSON.parse(toolCall.function.arguments || '{}')
			} catch {
				input = toolCall.function.arguments
			}
		}

		const output = deniedToolOutput(toolName, reason)

		this.log.info('Tool call denied — synthesizing tool_result', {
			[NAMZU.RUN_ID]: this.config.runId,
			[GENAI.TOOL_NAME]: toolName,
			'namzu.runtime.tool_use_id': toolCall.id,
			'namzu.runtime.reason': reason,
		})

		const activity = this.activityStore.create({
			type: 'tool_call',
			description: toolName,
			input,
			toolName,
			toolCallId: toolCall.id,
		})
		if (activity) {
			this.activityStore.start(activity.id)
			this.activityStore.fail(activity.id, output)
		}

		await this.emitEvent({
			type: 'tool_executing',
			runId: this.config.runId,
			toolUseId: toolCall.id,
			toolName,
			input,
		})
		await this.emitEvent({
			type: 'tool_completed',
			runId: this.config.runId,
			toolUseId: toolCall.id,
			toolName,
			result: output,
			isError: true,
		})

		return { toolCallId: toolCall.id, toolName, output, isError: true }
	}

	private async recordSyntheticHookOutcome(
		toolCallId: string,
		toolName: string,
		input: unknown,
		outcome: { kind: 'skip' | 'error'; output: string },
	): Promise<ToolCallOutcome> {
		const activity = this.activityStore.create({
			type: 'tool_call',
			description: toolName,
			input,
			toolName,
			toolCallId,
		})
		if (activity) {
			this.activityStore.start(activity.id)
			if (outcome.kind === 'skip') {
				this.activityStore.complete(activity.id, outcome.output)
			} else {
				this.activityStore.fail(activity.id, outcome.output)
			}
		}
		await this.emitEvent({
			type: 'tool_executing',
			runId: this.config.runId,
			toolUseId: toolCallId,
			toolName,
			input,
		})
		await this.emitEvent({
			type: 'tool_completed',
			runId: this.config.runId,
			toolUseId: toolCallId,
			toolName,
			result: outcome.output,
			isError: outcome.kind === 'error',
		})
		return {
			toolCallId,
			toolName,
			output: outcome.output,
			isError: outcome.kind === 'error',
		}
	}

	private recordSyntheticPreparation(call: Extract<PreparedDirectCall, { kind: 'synthetic' }>) {
		return this.recordSyntheticHookOutcome(call.toolCall.id, call.toolName, call.input, {
			kind: call.isError ? 'error' : 'skip',
			output: call.message,
		})
	}

	/**
	 * Bound the rich channel, or leave it alone when no cap is configured.
	 *
	 * Refused whole rather than trimmed: half a base64 payload is not a
	 * smaller image, it is a corrupt one, and a driver handed it would
	 * either fail the request or show the model noise. The text half stays
	 * untouched, so the result still says what happened — and the
	 * replacement names what was withheld and how big it was, which is what
	 * lets the agent ask for a smaller region instead of retrying the same
	 * call.
	 */
	private budgetContent(
		content: import('../../types/message/index.js').ToolResultContent,
		toolName: string,
	): import('../../types/message/index.js').ToolResultContent {
		const cap = this.config.maxToolContentBytes ?? 0
		if (cap <= 0) return content

		const size = measureContentBytes(content)
		if (size <= cap) return content

		this.log.warn('Tool result content exceeded the rich-content budget', {
			[NAMZU.RUN_ID]: this.config.runId,
			[GENAI.TOOL_NAME]: toolName,
			'namzu.runtime.content_bytes': size,
			'namzu.runtime.cap': cap,
		})

		const described = describeDroppedContent(content)
		return [
			{
				type: 'text',
				text: `[rich content withheld: ${size} base64 chars exceeds this run's ${cap} cap${
					described ? ` — ${described}` : ''
				}]`,
			},
		] as import('../../types/message/index.js').ToolResultContent
	}

	private maybeCompress(toolName: string, output: string): string {
		const tool = this.config.tools.get(toolName)
		if (!tool || tool.category !== 'shell') {
			return output
		}

		const compressed = compressShellOutput(output)
		if (compressed.length < output.length) {
			this.log.debug('Shell output compressed', {
				[GENAI.TOOL_NAME]: toolName,
				'namzu.runtime.original_length': output.length,
				'namzu.runtime.compressed_length': compressed.length,
				'namzu.runtime.reduction_percent': Math.round(
					(1 - compressed.length / output.length) * 100,
				),
			})
		}
		return compressed
	}
}

/** Minimal counting semaphore. FIFO, no timeout — the deadline is per-tool. */
class Semaphore {
	private available: number
	private readonly waiters: Array<() => void> = []

	constructor(permits: number) {
		this.available = Math.max(1, permits)
	}

	acquire(): Promise<void> {
		if (this.available > 0) {
			this.available--
			return Promise.resolve()
		}
		return new Promise<void>((resolve) => {
			this.waiters.push(resolve)
		})
	}

	release(): void {
		const next = this.waiters.shift()
		if (next) next()
		else this.available++
	}
}

function formatFailedToolOutput(output: string | undefined, error: string | undefined): string {
	const errorText = `Error: ${error ?? 'Tool execution failed'}`
	if (!output || output.trim().length === 0) return errorText
	return `${output}\n\n${errorText}`
}

function truncatedToolInputMessage(toolName: string): string {
	return `Error: Tool "${toolName}" call was cut off while the model was streaming JSON arguments. The tool was NOT executed. Retry with a much shorter input. Self-budget content/new_string under 12000 characters before calling file tools. For long files, create a short opening with write and a deterministic marker, then advance that marker with bounded exact edit calls; for delegated work, pass a shared workspace filename/reference instead of embedding the content in the tool call.`
}
