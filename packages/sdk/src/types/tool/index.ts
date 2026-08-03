import type { z } from 'zod'
import type { Logger } from '../../utils/logger.js'
import type { RunId } from '../ids/index.js'
import type { InvocationState } from '../invocation/index.js'
import type { PermissionMode } from '../permission/index.js'
import type { Sandbox } from '../sandbox/index.js'

export interface ToolRegistryRef {
	searchDeferred(query: string): ToolDefinition[]
	activate(names: string[]): void
	getAvailability(name: string): ToolAvailability
}

/**
 * Tracks which files the agent has read in the current run.
 * Write tool consults this to enforce the "read before overwrite" invariant
 * an existing file must be read first or the write fails.
 * Keys are the resolved path used by the tool — sandbox-relative when a sandbox
 * is active, absolute (`workingDirectory`-resolved) otherwise.
 */
export interface FileReadTracker {
	recordRead(key: string): void
	hasRead(key: string): boolean
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
	allowedTools?: readonly string[]
	sandbox?: Sandbox
	fileReadTracker?: FileReadTracker

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

export interface ToolDefinition<TInput = unknown> {
	name: string
	description: string
	inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>

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
