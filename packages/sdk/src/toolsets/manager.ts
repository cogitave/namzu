import { SpanStatusCode, context as otelContext, trace } from '@opentelemetry/api'
import { isCompactionMessage } from '../compaction/summary.js'
import { assertStrictSchema } from '../provider/strict-schema.js'
import { callableToolNames, formatToolNames } from '../registry/tool/callable.js'
import { assertToolName, describeWithOutput, toolDiscoveryHint } from '../registry/tool/execute.js'
import { renderToolSchema, toolWireSchema } from '../registry/tool/schema.js'
import { ToolResultHalted, screenToolResult } from '../registry/tool/screen.js'
import { GENAI, NAMZU, toolSpanName } from '../telemetry/attributes.js'
import { recordToolCall } from '../telemetry/metrics.js'
import { getTracer } from '../telemetry/runtime-accessors.js'
import { isTrustedReadOnly } from '../tools/trusted-read-only.js'
import type { ToolResultGuardrailSpec } from '../types/guardrail/index.js'
import type { Message } from '../types/message/index.js'
import { PLAN_MODE_REFUSAL } from '../types/permission/index.js'
import type {
	LLMToolSchema,
	PreparedToolExecution,
	ToolContext,
	ToolDefinition,
	ToolExecutionResult,
	ToolPreparationResult,
	ToolProvenance,
	ToolTierConfig,
	ToolsView,
} from '../types/tool/index.js'
import { toErrorMessage } from '../utils/error.js'
import { cloneJsonValue as clonePreparedInput } from '../utils/json-snapshot.js'
import { SCOPE_ATTRIBUTE } from '../utils/log/types.js'
import { type Logger, resolveLogger } from '../utils/logger.js'
import { ToolsetConflictError } from './combine.js'
import type { ToolSourceRef, Toolset, ToolsetAvailability } from './types.js'
import { toToolSourceRef } from './types.js'

export type { ToolExecutionResult }

/**
 * What `refresh()` reports after re-resolving a live toolset's change.
 *
 * `refused` is a newly-contributed name that would have collided with a name
 * already served by another toolset — the incumbent keeps serving and the
 * newcomer never reaches the manager, unlike a construction-time collision,
 * which throws instead (nothing was serving anyone yet, so there is nothing
 * to protect by continuing).
 */
export interface ToolsetChangeReport {
	/** Names a toolset started contributing that nobody else already served. */
	readonly added: readonly string[]
	/** Names whose owning toolset stopped contributing them, with no other toolset picking them up. */
	readonly removed: readonly string[]
	/**
	 * Names whose OWNING toolset now returns a different `ToolDefinition`
	 * object under the same name. The previously admitted definition keeps
	 * serving — see the class doc on why identity, not content, is what
	 * `toLLMTools`'s prompt-cache stability depends on.
	 */
	readonly drifted: readonly string[]
	/** A new contributor for a name some other toolset already serves. Refused, not applied. */
	readonly refused: readonly { readonly name: string; readonly reason: string }[]
}

export interface ToolManagerConfig {
	readonly toolsets: readonly Toolset[]
	/**
	 * Screens run against every tool result before anything downstream reads
	 * it. Wins over whatever the turn's own `ToolContext.toolResultGuardrails`
	 * supplies when this is present — including `[]`, which means none —
	 * because a manager built with an explicit policy has stated it. See
	 * `executeRetained` below.
	 */
	readonly resultGuardrails?: readonly ToolResultGuardrailSpec[]
	readonly tierConfig?: ToolTierConfig
	/**
	 * The turn's own message history, read fresh on every `availability`
	 * call rather than captured once — see {@link ToolManager.availability}.
	 */
	readonly messages: () => readonly Message[]
}

// Tokens too generic to identify a tool by name — ignored when matching a
// batched `search_tools` query so they can't activate the whole catalog.
// Copied from `registry/tool/execute.ts`'s `ToolRegistry.searchByAvailability`
// (same weights, same stop list); consolidate once that class is removed.
const SEARCH_STOP_TOKENS = new Set([
	'clawtool',
	'tool',
	'tools',
	'mcp',
	'the',
	'and',
	'for',
	'use',
	'list',
	'read',
	'create',
	'update',
	'get',
	'find',
	'delete',
	'search',
])

const SEARCH_WEIGHT_NAME_EXACT = 12
const SEARCH_WEIGHT_NAME_PARTIAL = 8
const SEARCH_WEIGHT_DESCRIPTION = 5
const SEARCH_WEIGHT_ARGUMENT = 3

/**
 * The runtime-owned resolver of {@link Toolset}s: plan.md v3 §2's
 * `ToolManager`, the analogue some other agent frameworks call a
 * "tool manager".
 *
 * Where `ToolRegistry` (`registry/tool/execute.ts`) is a public mutable bag
 * a host registers tools into over time, a `ToolManager` is built once from
 * a fixed list of toolsets and never mutates its own membership: a toolset
 * changing live (`onChange`) is only ever adopted when the caller calls
 * {@link refresh}, at an iteration boundary the caller chooses — never
 * mid-call. This is what keeps `toLLMTools`'s wire rendering byte-stable
 * between refreshes: `toolWireSchema` (`registry/tool/schema.ts`) memoizes a
 * tool's rendered schema by the object identity of `ToolDefinition.inputSchema`,
 * not by anything owned by whichever object resolved the tool, so returning
 * the SAME `ToolDefinition` object for the same name across calls — which a
 * fixed, never-mutated resolution trivially does — is what keeps the cache
 * hit.
 *
 * Availability has no stored, mutable map (unlike `ToolRegistry.availability`).
 * It is DERIVED: a tool is `'deferred'` iff its owning toolset declared
 * `'deferred'` (see `deferred()` in `./wrappers.ts`) and no tool message in
 * the turn's post-compaction history has revealed it. See
 * {@link ToolManager.availability}.
 *
 * The execution pipeline below (`prepareExecution`/`executePrepared`/
 * `execute`/`executeRetained`) is copied from `ToolRegistry`'s, per plan.md
 * §2: "Diff it line by line; the only permitted changes are where it read
 * `this.availability`, `tool.provenance` or registry identity." Those three
 * substitutions are exactly: `this.availability(name)` (derived, above) for
 * `this.getAvailability(name)`; `this.sourceOf(name)` for `tool.provenance`;
 * and `this.toolsByName` for `this.items`. Every check, in the same order,
 * with the same messages, is unchanged.
 */
export class ToolManager {
	private readonly toolsets: readonly Toolset[]
	private readonly resultGuardrails?: readonly ToolResultGuardrailSpec[]
	private readonly tierConfig?: ToolTierConfig
	private readonly messagesAccessor: () => readonly Message[]
	private readonly log: Logger

	private toolsByName = new Map<string, ToolDefinition>()
	private ownerToolsetByName = new Map<string, Toolset>()
	private defaultAvailabilityByName = new Map<string, ToolsetAvailability>()
	/**
	 * The object each name's owning toolset returned the LAST time `refresh()`
	 * (or construction) observed it — distinct from `toolsByName`, which holds
	 * whatever was first admitted under that name and never changes on drift.
	 * `refresh()` diffs against this map, not `toolsByName`, so a name that
	 * drifted once and has been stable ever since is not reported as drifted
	 * again just because some unrelated toolset's change forced a re-walk.
	 */
	private lastObservedByName = new Map<string, ToolDefinition>()
	private dirty = false

	private readonly preparations = new WeakMap<
		PreparedToolExecution,
		{ readonly tool: ToolDefinition; readonly input: unknown }
	>()

	constructor(config: ToolManagerConfig) {
		this.toolsets = config.toolsets
		this.resultGuardrails = config.resultGuardrails
		this.tierConfig = config.tierConfig
		this.messagesAccessor = config.messages
		this.log = resolveLogger(undefined).child({
			[SCOPE_ATTRIBUTE]: 'registry',
			[NAMZU.REGISTRY_NAME]: 'ToolManager',
		})

		this.resolveInitial()

		for (const toolset of this.toolsets) {
			toolset.onChange?.(() => {
				this.dirty = true
			})
		}
	}

	// ---- Composition / membership ----------------------------------------

	/**
	 * First resolution, at construction. Toolset order, then tool order,
	 * matching `combineToolsets` (`./combine.ts`) — a name contributed by two
	 * sources throws {@link ToolsetConflictError} naming both, because
	 * nothing has served anyone yet: unlike {@link refresh}, there is no
	 * incumbent to protect by refusing the newcomer instead.
	 */
	/**
	 * The checks `ToolRegistry.registerOne` used to run before admitting a
	 * tool, copied verbatim: a legal name; `enforceModelInput` requires a
	 * `modelInputSchema` (nothing to constrain generation against
	 * otherwise) and that schema must itself fit the strict-decoding subset
	 * `assertStrictSchema` checks (existing is not enough — it also has to
	 * be sendable); a declared `tier` must be one `this.tierConfig` lists.
	 */
	private assertAdmissible(tool: ToolDefinition): void {
		assertToolName(tool.name)
		if (tool.enforceModelInput && !tool.modelInputSchema) {
			throw new Error(
				`Tool "${tool.name}" enables enforceModelInput but does not define modelInputSchema. Constrained input generation requires an explicit provider-safe model schema.`,
			)
		}
		if (tool.enforceModelInput) {
			assertStrictSchema(tool.name, tool.modelInputSchema)
		}
		if (tool.tier && this.tierConfig) {
			const validIds = this.tierConfig.tiers.map((t) => t.id)
			if (!validIds.includes(tool.tier)) {
				throw new Error(
					`Tool "${tool.name}" has tier "${tool.tier}" which is not defined. Valid tiers: ${validIds.join(', ')}`,
				)
			}
		}
	}

	private resolveInitial(): void {
		const toolsByName = new Map<string, ToolDefinition>()
		const ownerToolsetByName = new Map<string, Toolset>()
		const defaultAvailabilityByName = new Map<string, ToolsetAvailability>()

		for (const toolset of this.toolsets) {
			for (const tool of toolset.tools()) {
				// The same admission checks `ToolRegistry.register` used to run
				// (name legality, `enforceModelInput`'s two schema
				// requirements, a declared tier's existence) — moved here
				// rather than dropped when that class went away. "Fail where
				// it can still be attributed" (at construction) instead of at
				// the first request.
				this.assertAdmissible(tool)
				const existingOwner = ownerToolsetByName.get(tool.name)
				if (existingOwner) {
					throw new ToolsetConflictError(tool.name, existingOwner.source, toolset.source)
				}
				toolsByName.set(tool.name, tool)
				ownerToolsetByName.set(tool.name, toolset)
				defaultAvailabilityByName.set(tool.name, toolset.availability ?? 'active')
			}
		}

		this.toolsByName = toolsByName
		this.ownerToolsetByName = ownerToolsetByName
		this.defaultAvailabilityByName = defaultAvailabilityByName
		this.lastObservedByName = new Map(toolsByName)
	}

	/**
	 * Re-resolve iff a toolset signalled change (`onChange`) since
	 * construction or the last `refresh()` — otherwise returns `undefined`
	 * without re-walking anything, so a caller that refreshes every
	 * iteration boundary pays nothing on the common case where nothing
	 * changed.
	 *
	 * Three outcomes per name, matching plan.md §2:
	 *  - A name only ONE current toolset contributes, that nobody served
	 *    before: `added`.
	 *  - A name a toolset served before and stopped, with no other toolset
	 *    now contributing it: `removed`.
	 *  - A name still contributed by its ORIGINAL owning toolset, under a
	 *    `ToolDefinition` object different from the one that toolset returned
	 *    the LAST time it was observed (construction, or the previous
	 *    `refresh()`): `drifted` — the previously admitted definition keeps
	 *    serving; the new object is held, not adopted, so `toolWireSchema`'s
	 *    identity-keyed cache (see the class doc) survives a live toolset's
	 *    own internal change. Comparing against the last OBSERVATION, not
	 *    the served object, means a name that drifted once and has been
	 *    stable since is reported only on the refresh where it actually
	 *    changed, not again on every later refresh some unrelated toolset's
	 *    change happens to trigger.
	 *  - A name some OTHER toolset starts contributing while its incumbent
	 *    owner still serves it: `refused` — the incumbent wins regardless of
	 *    toolset order; the newcomer is reported, never applied.
	 */
	refresh(): ToolsetChangeReport | undefined {
		if (!this.dirty) return undefined
		this.dirty = false

		const current = this.toolsets.map((toolset) => ({ toolset, tools: toolset.tools() }))
		const nextToolsByName = new Map<string, ToolDefinition>()
		const nextOwnerByName = new Map<string, Toolset>()
		const nextDefaultAvailabilityByName = new Map<string, ToolsetAvailability>()
		const nextLastObservedByName = new Map<string, ToolDefinition>()
		const added: string[] = []
		const drifted: string[] = []
		const refused: { name: string; reason: string }[] = []

		// Pass 1: every incumbent whose OWN owning toolset still offers it
		// keeps its slot — held at its OLD object identity even if the fresh
		// one differs (drift), so a live toolset's own change never bumps an
		// unrelated newcomer ahead of it, and never busts the wire-schema
		// identity cache mid-turn. Drift is judged against the last fresh
		// observation, not the held object, and that observation is updated
		// unconditionally so a name that just drifted is not drifted again
		// next time nothing about it has changed.
		for (const [name, ownerToolset] of this.ownerToolsetByName) {
			const ownerEntry = current.find((entry) => entry.toolset === ownerToolset)
			const freshTool = ownerEntry?.tools.find((tool) => tool.name === name)
			if (!freshTool) continue // handled as `removed` below, unless re-added by pass 2
			const oldTool = this.toolsByName.get(name)
			const lastObserved = this.lastObservedByName.get(name)
			if (lastObserved && freshTool !== lastObserved) drifted.push(name)
			nextToolsByName.set(name, oldTool ?? freshTool)
			nextOwnerByName.set(name, ownerToolset)
			nextDefaultAvailabilityByName.set(name, ownerToolset.availability ?? 'active')
			nextLastObservedByName.set(name, freshTool)
		}

		// Pass 2: walk every toolset, in order, for names no incumbent
		// claimed above. First writer among the CURRENTLY offered names wins;
		// anything already claimed here was necessarily claimed by pass 1
		// (an incumbent), so this can only ever refuse a newcomer, never an
		// incumbent.
		for (const { toolset, tools } of current) {
			for (const tool of tools) {
				const claimedBy = nextOwnerByName.get(tool.name)
				if (claimedBy) {
					if (claimedBy !== toolset) {
						refused.push({
							name: tool.name,
							reason: `tool "${tool.name}" is already served by "${claimedBy.source.id}"; "${toolset.source.id}" was refused. Rename it, or wrap the newcomer with prefixed(toolset, prefix).`,
						})
					}
					continue
				}
				nextToolsByName.set(tool.name, tool)
				nextOwnerByName.set(tool.name, toolset)
				nextDefaultAvailabilityByName.set(tool.name, toolset.availability ?? 'active')
				nextLastObservedByName.set(tool.name, tool)
				added.push(tool.name)
			}
		}

		const removed = [...this.toolsByName.keys()].filter((name) => !nextToolsByName.has(name))

		this.toolsByName = nextToolsByName
		this.ownerToolsetByName = nextOwnerByName
		this.defaultAvailabilityByName = nextDefaultAvailabilityByName
		this.lastObservedByName = nextLastObservedByName

		return { added, removed, drifted, refused }
	}

	has(name: string): boolean {
		return this.toolsByName.has(name)
	}

	get(name: string): ToolDefinition | undefined {
		return this.toolsByName.get(name)
	}

	listNames(): string[] {
		return [...this.toolsByName.keys()]
	}

	/** Where `name` came from. Throws for an unknown name, like {@link getOrThrow}. */
	sourceOf(name: string): ToolSourceRef {
		const ownerToolset = this.ownerToolsetByName.get(name)
		if (!ownerToolset) {
			throw new Error(`Not found: "${name}". Available: ${this.listNames().join(', ')}`)
		}
		return toToolSourceRef(ownerToolset.source)
	}

	private getOrThrow(name: string): ToolDefinition {
		const tool = this.toolsByName.get(name)
		if (!tool) {
			throw new Error(`Not found: "${name}". Available: ${this.listNames().join(', ')}`)
		}
		return tool
	}

	// ---- Availability (derived) -------------------------------------------

	/**
	 * `'deferred'` iff `name`'s owning toolset declared `'deferred'` AND no
	 * tool message in the current post-compaction history has revealed it.
	 * Otherwise `'active'`.
	 *
	 * Nothing here is stored: this is a pure read of the toolset's own
	 * declaration plus a scan of `messages()`, recomputed on every call — the
	 * same "safe to call repeatedly, byte-identical between calls" property
	 * `toLLMTools` already has. The scan is bounded to the window AFTER the
	 * last compaction summary (`compaction/summary.ts`'s
	 * `isCompactionMessage` — the one marker a compacted history carries, a
	 * system message whose content starts with `COMPACTION_HEADER`):
	 * compaction is the one deliberate "forget" boundary a derivation like
	 * this one needs, the same way it is the one boundary namzu's own
	 * summarisation treats as a reset. A tool message's own `revealedTools`
	 * (`types/message/index.ts`) is written by the executor from
	 * `ToolResult.reveals`, persisted like any other message field — there is
	 * no separate store to keep in sync, restore on resume, or lose across a
	 * fork.
	 */
	availability(name: string): ToolsetAvailability {
		const declared = this.defaultAvailabilityByName.get(name) ?? 'active'
		if (declared === 'active') return 'active'
		return this.wasRevealed(name) ? 'active' : 'deferred'
	}

	private wasRevealed(name: string): boolean {
		const window = postCompactionWindow(this.messagesAccessor())
		for (const message of window) {
			if (message.role === 'tool' && message.revealedTools?.includes(name)) return true
		}
		return false
	}

	private getByAvailability(
		states: readonly ToolsetAvailability[],
		filter?: readonly string[],
	): ToolDefinition[] {
		const candidates = filter
			? filter.map((name) => this.getOrThrow(name))
			: [...this.toolsByName.values()]
		return candidates.filter((tool) => states.includes(this.availability(tool.name)))
	}

	// ---- Discovery ----------------------------------------------------------

	/**
	 * Ranked lexical search over deferred tools — same scoring
	 * `ToolRegistry.searchDeferred` used (exact name 12 / name-substring 8 /
	 * description 5 / argument-name 3, generic tokens stopped), extended
	 * with an optional cap so a caller does not have to slice the result
	 * itself.
	 */
	searchDeferred(query: string, limit?: number): readonly ToolDefinition[] {
		const results = this.searchByAvailability(query, 'deferred')
		return limit === undefined ? results : results.slice(0, limit)
	}

	private searchByAvailability(query: string, state: ToolsetAvailability): ToolDefinition[] {
		const q = query.toLowerCase().trim()
		if (q.length === 0) return []
		const terms = q.split(/\s+/).filter((tok) => tok.length >= 3 && !SEARCH_STOP_TOKENS.has(tok))

		const scored: Array<{ tool: ToolDefinition; score: number }> = []
		for (const tool of this.toolsByName.values()) {
			if (this.availability(tool.name) !== state) continue
			const name = tool.name.toLowerCase()
			const description = tool.description.toLowerCase()
			const argumentNames = listArgumentNames(tool)
			let score = terms.length === 0 && name === q ? SEARCH_WEIGHT_NAME_EXACT : 0
			for (const term of terms) {
				if (name === term) {
					score += SEARCH_WEIGHT_NAME_EXACT
				} else if (name.includes(term)) {
					score += SEARCH_WEIGHT_NAME_PARTIAL
				}
				if (description.includes(term)) {
					score += SEARCH_WEIGHT_DESCRIPTION
				}
				if (argumentNames.some((arg) => arg.includes(term))) {
					score += SEARCH_WEIGHT_ARGUMENT
				}
			}
			if (score > 0) scored.push({ tool, score })
		}

		scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
		return scored.map((entry) => entry.tool)
	}

	// ---- Rendering to the model ----------------------------------------------

	toLLMTools(names?: readonly string[]): LLMToolSchema[] {
		const tools = this.getByAvailability(['active'], names)
		return tools.map((tool) => {
			let description = tool.description
			if (this.tierConfig?.labelInDescription && tool.tier) {
				const tierDef = this.tierConfig.tiers.find((t) => t.id === tool.tier)
				if (tierDef) description = `[${tierDef.label}] ${description}`
			}
			return {
				type: 'function' as const,
				function: {
					name: tool.name,
					description: describeWithOutput(description, tool.outputSchema),
					parameters: toolWireSchema(tool),
				},
			}
		})
	}

	toPromptSection(names?: readonly string[]): string {
		const active = this.getByAvailability(['active'], names)
		const deferred = this.getByAvailability(['deferred'], names)

		const parts: string[] = []
		const contractNote = `<tool_runtime_contract>
Executable tool names, descriptions, and JSON input schemas are attached through the runtime tools parameter. Treat that runtime schema as authoritative; this prompt section is a discoverability summary only.
</tool_runtime_contract>`

		if (active.length > 0) {
			const entries = active.map((t) => `- ${t.name}`).join('\n')
			parts.push(`<available_tools>\n${entries}\n</available_tools>`)
		}

		if (deferred.length > 0) {
			const entries = deferred
				.map((t) => {
					const hint = toolDiscoveryHint(t.description)
					return hint.length > 0 ? `- ${t.name}: ${hint}` : `- ${t.name}`
				})
				.join('\n')
			const deferredIntro =
				this.has('search_tools') &&
				this.availability('search_tools') === 'active' &&
				(!names || names.includes('search_tools'))
					? 'Use search_tools to load these before use:'
					: 'Deferred tools are discoverable but not executable until the runtime activates them:'
			parts.push(`<deferred_tools>\n${deferredIntro}\n${entries}\n</deferred_tools>`)
		}

		if (parts.length === 0) return ''
		return [contractNote, ...parts].join('\n\n')
	}

	toTierGuidance(): string | null {
		if (!this.tierConfig?.guidanceTemplate) return null
		return this.tierConfig.guidanceTemplate(this.tierConfig.tiers)
	}

	// ---- Narrow live view for a running tool's own `execute()` --------------

	/** What `ToolContext` gives a running tool: read-only, no mutation. */
	view(): ToolsView {
		return {
			has: (name) => this.has(name),
			availability: (name) => this.availability(name),
			searchDeferred: (query, limit) => this.searchDeferred(query, limit),
		}
	}

	// ---- Execution pipeline ---------------------------------------------
	//
	// Copied from `ToolRegistry` (`registry/tool/execute.ts:475-791`) per
	// plan.md §2. See the class doc for the three permitted substitutions;
	// everything else — order of checks, messages, the WeakMap ownership and
	// staleness re-check, the halt/fail distinction, the explicit parent
	// span — is unchanged.

	prepareExecution(toolName: string, rawInput: unknown): ToolPreparationResult {
		const tool = this.getOrThrow(toolName)
		const parseResult = tool.inputSchema.safeParse(rawInput)
		if (!parseResult.success) {
			return {
				success: false,
				result: this.validationFailure(tool, rawInput, parseResult.error),
			}
		}

		let retainedInput: unknown
		let reviewInput: unknown
		try {
			retainedInput = clonePreparedInput(parseResult.data, false)
			reviewInput = clonePreparedInput(retainedInput, true)
		} catch (err) {
			const message = `Tool "${toolName}" produced an input that cannot be safely prepared for review and execution: ${toErrorMessage(err)}`
			this.log.error('Prepared tool input could not be detached for review and execution', {
				'namzu.tool.name': toolName,
				'exception.message': toErrorMessage(err),
			})
			return {
				success: false,
				result: { success: false, output: '', error: message },
			}
		}

		const prepared = Object.freeze({ toolName, input: reviewInput })
		this.preparations.set(prepared, { tool, input: retainedInput })
		return { success: true, prepared }
	}

	async executePrepared(
		prepared: PreparedToolExecution,
		context: ToolContext,
	): Promise<ToolExecutionResult> {
		const retained = this.preparations.get(prepared)
		if (!retained) {
			return {
				success: false,
				output: '',
				error: `Tool "${prepared.toolName}" preparation is not owned by this registry or is no longer valid.`,
			}
		}
		if (this.toolsByName.get(prepared.toolName) !== retained.tool) {
			return {
				success: false,
				output: '',
				error: `Tool "${prepared.toolName}" changed after its input was reviewed; prepare the call again.`,
			}
		}
		return this.executeRetained(prepared.toolName, retained.tool, retained.input, context)
	}

	async execute(
		toolName: string,
		rawInput: unknown,
		context: ToolContext,
	): Promise<ToolExecutionResult> {
		let preparation: ToolPreparationResult
		try {
			preparation = this.prepareExecution(toolName, rawInput)
		} catch (err) {
			return this.rejectPreparationWithClosedSpan(toolName, context, err)
		}
		if (!preparation.success) return preparation.result
		return this.executePrepared(preparation.prepared, context)
	}

	private rejectPreparationWithClosedSpan(
		toolName: string,
		context: ToolContext,
		err: unknown,
	): Promise<never> {
		const tracer = getTracer()
		const parentCtx = context.parentSpan
			? trace.setSpan(otelContext.active(), context.parentSpan)
			: otelContext.active()
		return tracer.startActiveSpan(toolSpanName(toolName), {}, parentCtx, async (span) => {
			try {
				span.setAttributes({
					[GENAI.TOOL_NAME]: toolName,
					[GENAI.TOOL_TYPE]: 'function',
					...(context.toolUseId !== undefined ? { [GENAI.TOOL_CALL_ID]: context.toolUseId } : {}),
					...toolSpanIdentity(context),
					[NAMZU.TOOL_SUCCESS]: false,
					[NAMZU.TOOL_ERROR]: toErrorMessage(err),
				})
				span.setStatus({ code: SpanStatusCode.ERROR, message: toErrorMessage(err) })
				throw err
			} finally {
				span.end()
			}
		})
	}

	private async executeRetained(
		toolName: string,
		tool: ToolDefinition,
		finalInput: unknown,
		context: ToolContext,
	): Promise<ToolExecutionResult> {
		const tracer = getTracer()
		// The permitted `tool.provenance` substitution: a lean per-tool source
		// pointer from the OWNING toolset, computed once per call, rather than
		// something stamped onto the shared `ToolDefinition` object.
		const source = this.sourceOf(toolName)

		const parentCtx = context.parentSpan
			? trace.setSpan(otelContext.active(), context.parentSpan)
			: otelContext.active()

		return tracer.startActiveSpan(toolSpanName(toolName), {}, parentCtx, async (span) => {
			try {
				span.setAttributes({
					[GENAI.TOOL_NAME]: toolName,
					[GENAI.TOOL_TYPE]: 'function',
					...(context.toolUseId !== undefined ? { [GENAI.TOOL_CALL_ID]: context.toolUseId } : {}),
					...toolSpanIdentity(context),
				})

				// The permitted `this.getAvailability` substitution: derived,
				// not read off a stored map. See `availability` above.
				const availability = this.availability(toolName)
				if (availability !== 'active') {
					const msg = `Tool "${toolName}" is ${availability} and cannot be executed`
					this.log.warn(msg)
					span.setAttributes({
						[NAMZU.TOOL_SUCCESS]: false,
						[NAMZU.TOOL_ERROR]: msg,
					})
					span.setStatus({ code: SpanStatusCode.ERROR, message: msg })
					return {
						success: false,
						output: '',
						error: msg,
					}
				}

				const allowed = context.allowedTools
				if (allowed !== undefined && !allowed.includes(toolName)) {
					const msg = `Tool "${toolName}" is not available on this step. Available: ${formatToolNames(callableToolNames(this, allowed))}`
					this.log.warn('Blocked a tool outside the step allow-list', {
						[GENAI.TOOL_NAME]: toolName,
						'namzu.registry.allowed': allowed.length,
					})
					span.setAttributes({
						[NAMZU.TOOL_SUCCESS]: false,
						[NAMZU.TOOL_ERROR]: msg,
					})
					span.setStatus({ code: SpanStatusCode.ERROR, message: msg })
					return {
						success: false,
						output: '',
						error: msg,
						permissionDenied: true,
					}
				}

				const mode = context.permissionContext?.mode ?? 'auto'
				if (mode === 'plan') {
					const isReadOnly = isTrustedReadOnly(tool, finalInput, source)
					if (!isReadOnly) {
						const msg = `plan mode: non-read-only tool "${toolName}" blocked. ${PLAN_MODE_REFUSAL}`
						span.setAttributes({
							[NAMZU.TOOL_SUCCESS]: false,
							[NAMZU.TOOL_ERROR]: msg,
						})
						span.setStatus({ code: SpanStatusCode.ERROR, message: msg })
						return {
							success: false,
							output: '',
							error: msg,
							permissionDenied: true,
							permissionMessage: msg,
						}
					}
				}

				try {
					this.log.debug('Executing tool', { 'namzu.tool.name': toolName })
					const startedAt = Date.now()
					const runResultGuardrails = context.toolResultGuardrails
					const produced = await tool.execute(finalInput, context)
					const provenance = sourceToProvenance(source)
					const result = await screenToolResult(
						this.resultGuardrails ?? runResultGuardrails,
						produced,
						{
							toolName,
							input: finalInput,
							...(provenance ? { provenance } : {}),
						},
						this.log,
					)
					const durationMs = Date.now() - startedAt
					this.log.debug('Tool completed', {
						'namzu.tool.name': toolName,
						'namzu.registry.success': result.success,
					})

					span.setAttribute(NAMZU.TOOL_SUCCESS, result.success)
					recordToolCall(
						toolName,
						result.success,
						result.success ? undefined : result.error,
						durationMs,
					)
					if (!result.success && result.error) {
						span.setAttribute(NAMZU.TOOL_ERROR, result.error)
						span.setStatus({
							code: SpanStatusCode.ERROR,
							message: result.error,
						})
					} else {
						span.setStatus({ code: SpanStatusCode.OK })
					}

					return result
				} catch (err) {
					if (err instanceof ToolResultHalted) {
						span.setAttributes({
							[NAMZU.TOOL_SUCCESS]: false,
							[NAMZU.TOOL_ERROR]: err.message,
						})
						span.setStatus({
							code: SpanStatusCode.ERROR,
							message: err.message,
						})
						throw err
					}
					const errorMessage = toErrorMessage(err)
					this.log.error('Tool execution error', {
						'namzu.tool.name': toolName,
						'exception.message': errorMessage,
					})

					span.setAttributes({
						[NAMZU.TOOL_SUCCESS]: false,
						[NAMZU.TOOL_ERROR]: errorMessage,
					})
					span.setStatus({
						code: SpanStatusCode.ERROR,
						message: errorMessage,
					})
					span.recordException(err instanceof Error ? err : new Error(errorMessage))

					return {
						success: false,
						output: '',
						error: `Tool "${toolName}" execution failed: ${errorMessage}`,
					}
				}
			} finally {
				span.end()
			}
		})
	}

	private validationFailure(
		tool: ToolDefinition,
		rawInput: unknown,
		error: {
			readonly issues: readonly {
				readonly path: readonly PropertyKey[]
				readonly message: string
			}[]
		},
	): ToolExecutionResult {
		const errorMessage = error.issues
			.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
			.join('; ')
		const isEmptyInput =
			rawInput === null ||
			rawInput === undefined ||
			(typeof rawInput === 'object' &&
				!Array.isArray(rawInput) &&
				Object.keys(rawInput as Record<string, unknown>).length === 0)
		const requiredHint = describeRequiredInput(tool.inputSchema)
		const recoveryHint = tool.validationErrorHint?.trim()
			? ` ${tool.validationErrorHint.trim()}`
			: ''
		const enrichedMessage = isEmptyInput
			? `Tool "${tool.name}" was called with no arguments. ${requiredHint}${recoveryHint} Retry the call with the required parameters populated.`
			: `Validation failed for "${tool.name}": ${errorMessage}. ${requiredHint}${recoveryHint}`
		this.log.error('Tool input validation failed', {
			'namzu.tool.name': tool.name,
			'namzu.registry.errors': errorMessage,
			'namzu.registry.empty': isEmptyInput,
		})
		return { success: false, output: '', error: enrichedMessage }
	}
}

/**
 * The session and turn a tool span belongs to, copied from
 * `registry/tool/execute.ts`'s identically named private function.
 */
function toolSpanIdentity(context: ToolContext): Record<string, string> {
	return {
		...(context.sessionId ? { [GENAI.CONVERSATION_ID]: context.sessionId } : {}),
		...(context.turnId ? { [NAMZU.TURN_ID]: context.turnId } : {}),
	}
}

/** Project a `ToolSourceRef` to the `ToolProvenance` shape `screenToolResult` reads, for MCP-kind sources only. */
function sourceToProvenance(source: ToolSourceRef): ToolProvenance | undefined {
	if (source.kind !== 'mcp_server') return undefined
	return {
		server: source.server ?? source.id,
		readOnlyHintTrusted: source.readOnlyHintTrusted ?? false,
	}
}

/**
 * Every message after the last compaction summary. `isCompactionMessage`
 * (`compaction/summary.ts`) is the one marker a compacted history carries: a
 * system message whose content starts with `COMPACTION_HEADER`. No such
 * message means nothing has been compacted yet, so the whole history is the
 * window.
 */
function postCompactionWindow(messages: readonly Message[]): readonly Message[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message?.role === 'system' && isCompactionMessage(message.content)) {
			return messages.slice(i + 1)
		}
	}
	return messages
}

/**
 * Lower-cased argument (property) names of a tool's input schema, copied
 * from `registry/tool/execute.ts`'s identically named private function
 * (used by `searchByAvailability`'s ranking).
 */
function listArgumentNames(tool: ToolDefinition): string[] {
	try {
		const json = tool.modelInputSchema ?? renderToolSchema(tool.inputSchema)
		return [...collectSchemaPropertyNames(json)].map((key) => key.toLowerCase())
	} catch {
		return []
	}
}

/**
 * Every property name a schema can accept, including ones that only appear
 * inside a branch. Copied from `registry/tool/execute.ts`'s identically
 * named private function.
 */
function collectSchemaPropertyNames(
	schema: unknown,
	names: Set<string> = new Set(),
	seen: Set<object> = new Set(),
): Set<string> {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return names
	if (seen.has(schema)) return names
	seen.add(schema)

	const record = schema as Record<string, unknown>
	const properties = record.properties
	if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
		for (const name of Object.keys(properties)) names.add(name)
	}
	for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
		const branches = record[keyword]
		if (!Array.isArray(branches)) continue
		for (const branch of branches) collectSchemaPropertyNames(branch, names, seen)
	}
	return names
}

/**
 * Build a one-sentence "Required: <field>: <type>, …" validation hint.
 * Copied from `registry/tool/execute.ts`'s identically named private
 * function.
 */
function describeRequiredInput(schema: { _def?: unknown }): string {
	try {
		const json = renderToolSchema(schema as never) as {
			properties?: Record<string, { type?: string; description?: string }>
			required?: string[]
		}
		const required = json.required ?? []
		if (required.length === 0) return 'No required parameters known.'
		const props = json.properties ?? {}
		const lines = required.map((name) => {
			const def = props[name] ?? {}
			const type = def.type ?? 'value'
			const desc = def.description ? ` — ${def.description}` : ''
			return `${name}: ${type}${desc}`
		})
		return `Required: ${lines.join(', ')}.`
	} catch {
		return 'Could not introspect required parameters.'
	}
}
