import type { z } from 'zod'
import type { Logger } from '../../utils/logger.js'
// Type-only, and circular by design: a tool-result guardrail is described in
// terms of the tool that produced the result, and the registry that holds
// the guardrails is described here. Erased at compile time, so neither
// module exists at runtime to depend on the other.
import type { ToolResultGuardrailSpec } from '../guardrail/index.js'
import type { RunId } from '../ids/index.js'
import type { InvocationState } from '../invocation/index.js'
import type { PermissionMode } from '../permission/index.js'
import type { Sandbox } from '../sandbox/index.js'
import type { ToolPresentation } from './presentation.js'

export interface ToolRegistryRef {
	searchDeferred(query: string): ToolDefinition[]
	activate(names: string[]): void
	getAvailability(name: string): ToolAvailability
}

/**
 * The slice of the background job registry a tool is given.
 *
 * A structural reference rather than the class, for the reason
 * `ToolRegistryRef` exists: this type file is imported by everything, and
 * naming the implementation here would drag a `node:child_process` module
 * into every consumer's type graph. `owner` is not on this surface at all —
 * the executor binds it to the run, so a tool cannot start a job that
 * outlives, or is billed to, somebody else's run.
 */
/**
 * The slice of the skills registry a tool is given.
 *
 * Structural for the reason `ToolRegistryRef` is: this file is imported by
 * everything, and naming `SkillRegistry` here would drag the skill loader's
 * filesystem imports into every consumer's type graph.
 */
export interface SkillRegistryRef {
	/**
	 * Load a skill's full body, or `undefined` for a name nobody registered.
	 *
	 * Full disclosure by design: a tool call asking for a skill is asking
	 * for its instructions, and returning metadata the model already has in
	 * its manifest would answer a question it did not ask.
	 */
	load(name: string): Promise<
		| {
				skill: {
					metadata: {
						name: string
						description: string
						allowedTools?: string
						/**
						 * The literal union, not `string`. Widening it here would
						 * let a ref satisfy this interface while carrying a value
						 * `isInvocableBy` cannot read, and the failure would be a
						 * silent `both` — the fail-open answer.
						 */
						invocation?: 'model' | 'operator' | 'both'
					}
					body?: string
				}
		  }
		| undefined
	>
	/** Every registered name, for a "did you mean" that names real options. */
	names(): readonly string[]
}

export interface BackgroundJobRegistryRef {
	start(params: { command: string; workingDirectory: string }): { id: string; status: string }
	get(id: string): { id: string; status: string; exitCode?: number }
	read(
		id: string,
		opts?: { fromOffset?: number },
	): {
		chunk: string
		nextOffset: number
		droppedBytes: number
		status: string
		exitCode?: number
	}
	kill(id: string): Promise<{ id: string; status: string }>
	list(): readonly { id: string; command: string; status: string }[]
}

/**
 * Tracks which files the agent has read in the current run.
 * Write tool consults this to enforce the "read before overwrite" invariant
 * an existing file must be read first or the write fails.
 * Keys are the resolved path used by the tool — sandbox-relative when a sandbox
 * is active, absolute (`workingDirectory`-resolved) otherwise.
 */
export interface FileReadTracker {
	/**
	 * `content` lets the tracker fingerprint what was read, which is what
	 * makes drift detectable later. Optional so a host that only needs the
	 * read-before-overwrite guard can keep its existing implementation.
	 */
	recordRead(key: string, content?: string): void
	hasRead(key: string): boolean
	/**
	 * Fingerprint of the body captured at the last read, when one was.
	 *
	 * A file mutation is computed against what the agent READ, and between
	 * that read and the write the file may have moved under it — a person
	 * editing in an editor, another process, a second agent. The in-process
	 * lock cannot see any of those. Comparing this against the body actually
	 * on disk at mutation time is what turns a silent lost update into a
	 * refusal the agent can act on by re-reading.
	 */
	fingerprint?(key: string): string | undefined
}

export interface ToolPauseOption {
	readonly id: string
	readonly label: string
	readonly description?: string
}

export interface ToolPauseRequest {
	/**
	 * Names this pause within the call.
	 *
	 * A tool call may pause more than once — "which environment", then
	 * "are you sure" — and the answers have to be told apart. The name is
	 * what a resume payload is routed by, so it is the author's to choose
	 * and should describe the decision, not the tool.
	 */
	readonly name: string
	/** The question, in the words the human will read. */
	readonly prompt: string
	/** Short topic label, when the surface showing this has room for one. */
	readonly header?: string
	readonly options?: readonly ToolPauseOption[]
	readonly multiSelect?: boolean
	/** Defaults to true: a human who disagrees with every option can say so. */
	readonly allowFreeText?: boolean
}

/**
 * How a pause ended.
 *
 * `unanswered` is deliberately not a variant of `answered` with an empty
 * selection. A tool that pauses to ask "may I charge this card" and reads
 * silence as yes is worse than one that never asked, so the absence of an
 * answer has its own shape and cannot be destructured into consent by
 * accident.
 */
export type ToolPauseOutcome =
	| {
			readonly status: 'answered'
			readonly selectedOptionIds: readonly string[]
			readonly text?: string
	  }
	| { readonly status: 'unanswered'; readonly reason: string }
	| { readonly status: 'aborted' }

export type RequestToolPause = (request: ToolPauseRequest) => Promise<ToolPauseOutcome>

export interface ToolContext {
	runId: RunId
	workingDirectory: string
	abortSignal: AbortSignal
	env: Record<string, string>
	log: (level: 'info' | 'warn' | 'error', message: string) => void
	permissionContext?: {
		mode: PermissionMode
		runId: string
		workingDirectory: string
	}

	invocationState?: InvocationState

	toolRegistry?: ToolRegistryRef
	/**
	 * The names this turn may call, if the turn was narrowed.
	 *
	 * Enforced at dispatch, not only used to decide which schemas the model is
	 * shown. It was the latter alone for a while, which made the narrowing
	 * presentational: a step could withhold a tool from the request and the
	 * executor would still run it when the model named it anyway — from
	 * repeated context, from a gateway with its own tool memory, or from a
	 * replayed prefix.
	 *
	 * Absent means no narrowing, which is not the same as an empty list: an
	 * empty list is a turn that may call nothing.
	 */
	allowedTools?: readonly string[]
	sandbox?: Sandbox
	fileReadTracker?: FileReadTracker

	/**
	 * Where work that outlives this call is held.
	 *
	 * Absent means the host has provided nowhere to put a background job, and
	 * a tool asked for one must REFUSE rather than fall back to `cmd &`. The
	 * fallback is not a lesser version of this — under the local sandbox's
	 * `linux-namespace` tier the wrapping `sh` is PID 1 of a fresh PID
	 * namespace, so a backgrounded grandchild dies the moment that shell
	 * exits, on the successful path. It returns in milliseconds looking like
	 * it worked, with the work already dead.
	 */
	backgroundJobs?: BackgroundJobRegistryRef

	/**
	 * Where the `skill` tool reads from.
	 *
	 * Absent means the run has no skills, and the tool says so rather than
	 * reporting an empty list — "no skills here" and "no registry" are
	 * different answers.
	 */
	skills?: SkillRegistryRef

	/**
	 * How this run reaches the web.
	 *
	 * Two independent halves, and either may be absent. This kernel ships a
	 * guarded fetch provider and NO search backend, so `search` missing is
	 * the ordinary case rather than a failure — the tools say which piece is
	 * missing so an operator can tell a wiring decision from a fault.
	 */
	web?: {
		readonly fetch?: {
			fetch(request: { url: string; signal?: AbortSignal }): Promise<{
				url: string
				status: number
				contentType?: string
				body: string
				truncated: boolean
				redirects: readonly string[]
			}>
		}
		readonly search?: {
			search(request: { query: string; limit?: number; signal?: AbortSignal }): Promise<{
				query: string
				hits: readonly { title: string; url: string; snippet?: string }[]
			}>
		}
	}

	/**
	 * Adopt the tool scope a skill declared.
	 *
	 * Called by the `skill` tool when a loaded skill names `allowed-tools`.
	 * The scope INTERSECTS what the turn already allows and takes effect from
	 * the next batch — a skill loaded alongside other calls must not
	 * retroactively refuse them.
	 */
	adoptSkillScope?: (scope: { skill: string; allowedTools: readonly string[] }) => void

	/**
	 * The `tool_use_id` of the assistant block that triggered this
	 * execution. Tools that spawn background work (e.g. coordinator
	 * `create_task`) thread this id into their tracking metadata so
	 * a later, asynchronous completion can be replied back as a
	 * canonical `tool_result` content block bound to the same id.
	 * Optional because not every executor path provides it yet.
	 */
	toolUseId?: string

	/**
	 * Raise a durable pause and wait for a human to resolve it.
	 *
	 * The pause machinery is excellent and was reachable from exactly four
	 * kernel-owned points — the plan gate, the tool-review gate, the
	 * iteration cadence, and one built-in question tool. A host-authored
	 * tool had no seam to it, so the operations that most want their own
	 * confirmation with their own wording (a spend, an outbound post, a
	 * destructive migration) had to settle for the generic tool-review
	 * gate or hand-thread a recorder and a resume callback into a private
	 * builder, which nothing in this type suggested was possible.
	 *
	 * The park is a real checkpoint, so a host can see the pause on every
	 * surface a tool-review park appears on, and the answer routes back by
	 * name on resume — several tools pausing in one batch each get their
	 * own, and one tool may pause more than once.
	 *
	 * Absent when whatever is driving the tool provides no route to a
	 * human — a host calling a tool directly, outside a run. A tool must
	 * treat it as optional and decide what to do without one, and must
	 * never read an unanswered pause as consent; the outcome says which it
	 * was, in its own shape, so silence cannot be destructured into a yes.
	 */
	requestPause?: RequestToolPause

	/**
	 * Span to parent this tool's `execute_tool` span to.
	 *
	 * OTel's GenAI conventions define a strict hierarchy —
	 * `invoke_agent` → `chat {model}` → `execute_tool` — and vendor
	 * dashboards rely on it. `startActiveSpan` cannot supply the parent
	 * here: the span-owning bodies upstream are async GENERATORS, and a
	 * generator resumes on its consumer's async context, so the ambient
	 * context is already gone by the time a tool runs. Passing the parent
	 * explicitly is the only approach that actually works, and
	 * `ToolContext` is already threaded to exactly the right place.
	 */
	parentSpan?: import('@opentelemetry/api').Span

	/**
	 * Say how far along you are, for a host rendering a live view.
	 *
	 * A tool may run for the full per-tool deadline — two minutes by
	 * default — and before this it was silent for all of it: a host could
	 * show that a build had started and then nothing until it finished or
	 * timed out.
	 *
	 * Fire-and-forget and never throws, so a tool can call it freely
	 * without wrapping it. The model never sees these: progress answers
	 * "is it still working?", which is a question only a human asks, and
	 * putting it in the conversation would spend tokens telling the model
	 * something it cannot act on.
	 *
	 * Absent when the executing surface has no event stream to write to.
	 */
	report?: (message: string, fraction?: number) => void
}

export interface ToolResult {
	success: boolean
	output: string
	data?: unknown
	error?: string
	/**
	 * Rich content for the MODEL, when a string cannot carry it — a
	 * screenshot, a chart, a PDF. `output` stays the text the host and the
	 * transcript see; when this is set it is what reaches the provider.
	 *
	 * Keeping the two separate is deliberate: a host UI wants "screenshot
	 * (1280x800)", the model wants the pixels, and forcing one channel to
	 * serve both is what made `computer-use` send megabytes of base64 as
	 * text.
	 */
	content?: import('../message/index.js').ToolResultContent

	/**
	 * This failure might succeed if tried again — a network blip, a lock
	 * contention, a rate limit — as opposed to one that never will, like a
	 * missing file or a rejected argument.
	 *
	 * Nothing distinguished the two before, so a transient failure cost a
	 * full model round trip to retry: the error went back as a
	 * `tool_result`, the model read it, and decided (or didn't) to call
	 * again. Only meaningful alongside {@link ToolDefinition.maxRetries};
	 * a tool that has not opted into retries is never retried no matter
	 * what it sets here.
	 */
	retryable?: boolean
}

export interface ToolDefinition<TInput = unknown> extends ToolPresentation<TInput> {
	name: string
	description: string
	inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>
	/**
	 * Optional canonical JSON Schema shown to models instead of the runtime
	 * Zod schema. Use this when runtime compatibility accepts aliases or
	 * constraints that should not be advertised to a model.
	 *
	 * This is intentionally independent of TInput: the model-facing contract
	 * may be narrower than the execution decoder.
	 */
	modelInputSchema?: Record<string, unknown>
	/**
	 * Ask capable providers to constrain generated input to modelInputSchema.
	 * ToolRegistry rejects this flag unless modelInputSchema is also present.
	 */
	enforceModelInput?: boolean
	/**
	 * Concise, model-readable recovery guidance appended when inputSchema
	 * rejects a call. Use for conditional schemas whose required shapes
	 * cannot be reconstructed from JSON Schema's top-level `required` list.
	 */
	validationErrorHint?: string

	/**
	 * The shape this tool returns, as JSON Schema, appended to the
	 * description the model sees.
	 *
	 * JSON Schema rather than Zod because it is **shown, never validated**:
	 * namzu does not check a tool's return value against it, so converting
	 * through Zod would only cost fidelity. Native tools that want one can
	 * render their Zod type with `renderToolSchema`.
	 *
	 * Optional and omitted by default — a tool whose return shape is
	 * obvious from its description gains nothing from spending prompt on
	 * it, and every tool schema rides in the cached prefix of every
	 * request.
	 */
	outputSchema?: Record<string, unknown>
	execute(input: TInput, context: ToolContext): Promise<ToolResult>
	tier?: string
	permissions?: ToolPermission[]
	category?: 'filesystem' | 'shell' | 'network' | 'analysis' | 'custom'

	/**
	 * Deadline for a single execution, overriding the run-level default.
	 *
	 * On expiry the executor stops waiting and returns a model-visible
	 * error result, so a slow dependency becomes something the agent can
	 * route around instead of a turn that never comes back. The tool's
	 * `context.abortSignal` fires at the same moment; a tool that honours
	 * it also stops doing work, and one that ignores it merely becomes
	 * detached.
	 *
	 * Omit to inherit the executor's default.
	 */
	timeoutMs?: number

	/**
	 * How many times a FAILED execution may be retried in-loop before the
	 * error is handed to the model.
	 *
	 * **Defaults to 0, and that default is load-bearing.** Retrying is only
	 * safe if the tool is idempotent, and the SDK cannot know that: silently
	 * re-running a `write_file`, a `git push` or a payment call is worse
	 * than never retrying at all. The tool author opts in, per tool.
	 *
	 * Even then, only failures the tool marked
	 * {@link ToolResult.retryable} are retried — a missing file is not
	 * going to appear on the second attempt, and burning the budget on it
	 * just delays the error the model needs to see.
	 */
	maxRetries?: number

	/**
	 * This tool's output IS the run's answer: settle with it instead of
	 * asking the model to restate it.
	 *
	 * Every delegation path is blocking and returns the worker's final
	 * text as the dispatching call's result, after which the loop went
	 * round again — so a router agent, whose entire job is to pick a
	 * specialist, paid one extra model call per request at the parent's
	 * full context size, the most expensive call in the run. The relay is
	 * also LOSSY: the parent paraphrases the worker's answer through its
	 * own (compacted) context, so what the caller receives is not what the
	 * worker produced.
	 *
	 * Honoured only when the terminal call is the ONLY call in the turn
	 * and it did not fail. A model that asked for other work in the same
	 * turn meant to see those results, and ending the run would discard
	 * answers it requested; that turn takes the ordinary path and the
	 * reason is logged. A failed terminal call is not an answer either —
	 * the error goes back to the model, which is the point of returning
	 * errors to it at all.
	 *
	 * Off by default. The generic case is `structured_output`, which the
	 * runtime has always settled on; this is that rule made available to
	 * any tool.
	 */
	terminal?: boolean

	isReadOnly?(input: TInput): boolean
	isDestructive?(input: TInput): boolean
	isConcurrencySafe?(input: TInput): boolean

	/**
	 * Where this tool came from, when it did not come from here.
	 *
	 * Absent means host-defined: this process, code the operator installed,
	 * no untrusted party in the chain. Present means a connected server
	 * supplied both the tool and its own description of what the tool does
	 * — including whether it is read-only, which three separate gates were
	 * treating as a fact rather than as the hint the wire calls it.
	 *
	 * See {@link isTrustedReadOnly}. This field exists so a gate can tell
	 * the two apart; `isReadOnly` keeps reporting faithfully what the
	 * server said, because the outbound re-export and the destructive
	 * label shown to a human both need the server's own answer.
	 */
	provenance?: ToolProvenance
}

export interface ToolProvenance {
	/** The connected server this tool came from, named as configured. */
	readonly server: string
	/**
	 * The operator marked this server's read-only claims as trustworthy.
	 *
	 * Per server, never global: one switch meaning "trust annotations"
	 * hands every connected server the same reach, which is the hole it
	 * would be closing. Default false — an unmarked server's claim raises
	 * the requirement and never lowers it.
	 */
	readonly readOnlyHintTrusted: boolean
}

export type ToolPermission =
	| 'file_read'
	| 'file_write'
	| 'shell_execute'
	| 'network_access'
	| 'env_access'

export interface LLMToolSchema {
	type: 'function'
	function: {
		name: string
		description: string
		parameters: Record<string, unknown>
	}
}

export type ToolAvailability = 'deferred' | 'active' | 'suspended'

export type ZodToJsonSchema = (schema: z.ZodType) => Record<string, unknown>

export interface ToolTierDefinition {
	id: string
	label: string
	priority: number
	description?: string
}

export interface ToolTierConfig {
	tiers: ToolTierDefinition[]
	guidanceTemplate?: (tiers: ToolTierDefinition[]) => string
	labelInDescription?: boolean
}

export interface ToolRegistryConfig {
	logger?: Logger
	tierConfig?: ToolTierConfig
	/**
	 * Screens run against every tool result before anything downstream
	 * reads it — the output budget, compaction, and the model itself are
	 * all past this point.
	 *
	 * Absent means no screening, which is what shipped before this existed:
	 * a connected server's text reached the model unexamined. See
	 * {@link ToolResultGuardrailSpec}.
	 */
	resultGuardrails?: readonly ToolResultGuardrailSpec[]
}

export interface ToolExecutionResult extends ToolResult {
	permissionDenied?: boolean
	permissionMessage?: string
}

/**
 * Full tool registry contract — registration, lookup, execution, prompt generation.
 * Concrete implementation: `ToolRegistry` in `registry/tool/execute.ts`.
 */
export interface ToolRegistryContract {
	register(id: string, tool: ToolDefinition): void
	register(tool: ToolDefinition, initialState?: ToolAvailability): void
	register(tools: ToolDefinition[], initialState?: ToolAvailability): void

	unregister(id: string): boolean
	clear(): void

	get(name: string): ToolDefinition | undefined
	getOrThrow(name: string): ToolDefinition
	has(name: string): boolean
	getAll(): ToolDefinition[]
	listIds(): string[]
	listNames(): string[]

	getAvailability(name: string): ToolAvailability
	activate(names: string[]): void
	defer(names: string[]): void
	suspendAll(): void
	hasSuspended(): boolean
	searchDeferred(query: string): ToolDefinition[]
	getCallableTools(toolNames?: string[]): ToolDefinition[]

	execute(toolName: string, rawInput: unknown, context: ToolContext): Promise<ToolExecutionResult>

	size(): number

	toLLMTools(toolNames?: string[]): LLMToolSchema[]
	toPromptSection(toolNames?: string[]): string
	toTierGuidance(): string | null
	assignTiers(mapping: Record<string, string>): void
}

export * from './repair.js'

export type { ToolCallView, ToolPresentation, ToolResultView } from './presentation.js'
