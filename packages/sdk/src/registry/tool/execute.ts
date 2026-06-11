import { SpanStatusCode } from '@opentelemetry/api'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { GENAI, NAMZU, toolSpanName } from '../../telemetry/attributes.js'
import { getTracer } from '../../telemetry/runtime-accessors.js'
import type {
	LLMToolSchema,
	ToolAvailability,
	ToolContext,
	ToolDefinition,
	ToolExecutionResult,
	ToolRegistryConfig,
	ToolTierConfig,
} from '../../types/tool/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { ManagedRegistry } from '../ManagedRegistry.js'

export type { ToolExecutionResult }

// Tokens too generic to identify a tool by name — ignored when matching a
// batched `search_tools` query so they can't activate the whole catalog
// (every bridged tool name shares the `clawtool` prefix, for instance).
// Generic CRUD verbs are stopped too: a query like "list deals" must rank
// by "deals", not token-match every `list_*` tool in the deferred catalog.
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

// Weighted-scoring weights mirroring ToolCatalog.searchTools (the richer,
// otherwise-unused catalog scorer): exact name 12, name substring 8,
// description 5 — extended here with argument-name indexing (3), following
// Anthropic's tool-search practice of searching argument names too.
const SEARCH_WEIGHT_NAME_EXACT = 12
const SEARCH_WEIGHT_NAME_PARTIAL = 8
const SEARCH_WEIGHT_DESCRIPTION = 5
const SEARCH_WEIGHT_ARGUMENT = 3

export class ToolRegistry extends ManagedRegistry<ToolDefinition> {
	private availability: Map<string, ToolAvailability> = new Map()
	private tierConfig?: ToolTierConfig

	constructor(config?: ToolRegistryConfig) {
		super({ componentName: 'ToolRegistry', idField: 'name', logger: config?.logger })
		this.tierConfig = config?.tierConfig
	}

	override register(id: string, tool: ToolDefinition): void
	override register(tool: ToolDefinition, initialState?: ToolAvailability): void
	override register(tools: ToolDefinition[], initialState?: ToolAvailability): void
	override register(
		idOrToolOrTools: string | ToolDefinition | ToolDefinition[],
		maybeTool?: ToolDefinition | ToolAvailability,
	): void {
		if (Array.isArray(idOrToolOrTools)) {
			const state = (typeof maybeTool === 'string' ? maybeTool : 'active') as ToolAvailability
			for (const tool of idOrToolOrTools) {
				this.registerOne(tool.name, tool, state)
			}
			return
		}

		if (typeof idOrToolOrTools === 'string') {
			if (!maybeTool || typeof maybeTool === 'string') {
				throw new Error('register(id, tool) requires a ToolDefinition argument')
			}
			this.registerOne(idOrToolOrTools, maybeTool, 'active')
			return
		}

		const tool = idOrToolOrTools
		const state: ToolAvailability = typeof maybeTool === 'string' ? maybeTool : 'active'

		this.registerOne(tool.name, tool, state)
	}

	private registerOne(id: string, tool: ToolDefinition, state: ToolAvailability): void {
		if (tool.tier && this.tierConfig) {
			const validIds = this.tierConfig.tiers.map((t) => t.id)
			if (!validIds.includes(tool.tier)) {
				throw new Error(
					`Tool "${id}" has tier "${tool.tier}" which is not defined. Valid tiers: ${validIds.join(', ')}`,
				)
			}
		}
		super.register(id, tool)
		this.availability.set(id, state)
	}

	override unregister(id: string): boolean {
		this.availability.delete(id)
		return super.unregister(id)
	}

	override clear(): void {
		this.availability.clear()
		super.clear()
	}

	activate(names: string[]): void {
		for (const name of names) {
			this.getOrThrow(name)
			this.availability.set(name, 'active')
			this.log.debug(`Tool activated: ${name}`)
		}
	}

	defer(names: string[]): void {
		for (const name of names) {
			this.getOrThrow(name)
			this.availability.set(name, 'deferred')
			this.log.debug(`Tool deferred: ${name}`)
		}
	}

	suspendAll(): void {
		for (const name of this.listIds()) {
			if (this.getAvailability(name) === 'active') {
				this.availability.set(name, 'suspended')
			}
		}
		this.log.info('All active tools suspended')
	}

	hasSuspended(): boolean {
		for (const state of this.availability.values()) {
			if (state === 'suspended') return true
		}
		return false
	}

	getAvailability(name: string): ToolAvailability {
		return this.availability.get(name) ?? 'active'
	}

	/**
	 * Ranked lexical search over DEFERRED tools, score-descending (ties broken
	 * by name) so callers can cap activation at a top-k. Each meaningful query
	 * term (≥3 chars, not a stop token) is scored against the tool name
	 * (exact/substring), description, and argument names; only tools with a
	 * positive score are returned. Description matching is safe here precisely
	 * because the result is RANKED — the `search_tools` builtin activates only
	 * the top slice, so a shared word can no longer drag in the whole catalog.
	 *
	 * PARKED (phase 5 of the tool-loading plan): an embedding-backed semantic
	 * upgrade was evaluated and deliberately NOT built — at ≤~35 deferred
	 * in-house tools with distinct names, weighted lexical scoring sits inside
	 * the literature's safe zone, and a weak retriever underperforms no
	 * retriever at all. Revisit only when (a) the deferred catalog grows past
	 * ~75-100 tools (realistic driver: connector-MCP growth), or (b) telemetry
	 * shows a search_tools miss-rate above ~10%. Sticky activation is also
	 * deliberate: activating inserts the schema into the tools array at its
	 * registry position (a one-time prompt-cache prefix bust); re-defer/TTL
	 * would churn that prefix repeatedly and is rejected.
	 */
	searchDeferred(query: string): ToolDefinition[] {
		const q = query.toLowerCase().trim()
		if (q.length === 0) return []
		const terms = q.split(/\s+/).filter((tok) => tok.length >= 3 && !SEARCH_STOP_TOKENS.has(tok))
		if (terms.length === 0) return []

		const scored: Array<{ tool: ToolDefinition; score: number }> = []
		for (const tool of this.getByAvailability(['deferred'])) {
			const name = tool.name.toLowerCase()
			const description = tool.description.toLowerCase()
			const argumentNames = listArgumentNames(tool)
			let score = 0
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
			if (score > 0) {
				scored.push({ tool, score })
			}
		}

		scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
		return scored.map((entry) => entry.tool)
	}

	assignTiers(mapping: Record<string, string>): void {
		for (const [toolName, tierId] of Object.entries(mapping)) {
			const tool = this.getOrThrow(toolName)
			if (this.tierConfig) {
				const validIds = this.tierConfig.tiers.map((t) => t.id)
				if (!validIds.includes(tierId)) {
					throw new Error(
						`Tier "${tierId}" for tool "${toolName}" is not defined. Valid tiers: ${validIds.join(', ')}`,
					)
				}
			}
			tool.tier = tierId
		}
	}

	toTierGuidance(): string | null {
		if (!this.tierConfig?.guidanceTemplate) return null
		return this.tierConfig.guidanceTemplate(this.tierConfig.tiers)
	}

	listNames(): string[] {
		return this.listIds()
	}

	toPromptSection(toolNames?: string[]): string {
		const active = this.getByAvailability(['active'], toolNames)
		const deferred = this.getByAvailability(['deferred'], toolNames)

		const parts: string[] = []
		const contractNote = `<tool_runtime_contract>
Executable tool names, descriptions, and JSON input schemas are attached through the runtime tools parameter. Treat that runtime schema as authoritative; this prompt section is a discoverability summary only.
</tool_runtime_contract>`

		if (active.length > 0) {
			// Name-only: every active tool's full description + JSON schema
			// already rides the runtime tools parameter on each request —
			// repeating descriptions here double-bills the same tokens.
			const entries = active.map((t) => `- ${t.name}`).join('\n')
			parts.push(`<available_tools>\n${entries}\n</available_tools>`)
		}

		if (deferred.length > 0) {
			// Name + one-line hint: deferred schemas stay off the wire, so the
			// hint is the model's only signal of what a deferred tool does. A
			// bare name list caused a real discovery failure in production
			// (the agent never found read_document behind search_tools).
			const entries = deferred
				.map((t) => {
					const hint = toolDiscoveryHint(t.description)
					return hint.length > 0 ? `- ${t.name}: ${hint}` : `- ${t.name}`
				})
				.join('\n')
			const deferredIntro =
				this.has('search_tools') && this.getAvailability('search_tools') === 'active'
					? 'Use search_tools to load these before use:'
					: 'Deferred tools are discoverable but not executable until the runtime activates them:'
			parts.push(`<deferred_tools>\n${deferredIntro}\n${entries}\n</deferred_tools>`)
		}

		if (parts.length === 0) return ''
		return [contractNote, ...parts].join('\n\n')
	}

	toLLMTools(toolNames?: string[]): LLMToolSchema[] {
		const toolsToConvert = this.getByAvailability(['active', 'suspended'], toolNames)

		return toolsToConvert.map((tool) => {
			let description = tool.description
			if (this.tierConfig?.labelInDescription && tool.tier) {
				const tierDef = this.tierConfig.tiers.find((t) => t.id === tool.tier)
				if (tierDef) {
					description = `[${tierDef.label}] ${description}`
				}
			}
			return {
				type: 'function' as const,
				function: {
					name: tool.name,
					description,
					parameters: zodToJsonSchema(tool.inputSchema, {
						target: 'jsonSchema7',
						$refStrategy: 'none',
					}) as Record<string, unknown>,
				},
			}
		})
	}

	getCallableTools(toolNames?: string[]): ToolDefinition[] {
		return this.getByAvailability(['active'], toolNames)
	}

	async execute(
		toolName: string,
		rawInput: unknown,
		context: ToolContext,
	): Promise<ToolExecutionResult> {
		const tracer = getTracer()

		return tracer.startActiveSpan(toolSpanName(toolName), async (span) => {
			span.setAttributes({
				[GENAI.TOOL_NAME]: toolName,
				[GENAI.TOOL_TYPE]: 'function',
			})

			const tool = this.getOrThrow(toolName)

			const availability = this.getAvailability(toolName)
			if (availability !== 'active') {
				const msg = `Tool "${toolName}" is ${availability} and cannot be executed`
				this.log.warn(msg)
				span.setAttributes({
					[NAMZU.TOOL_SUCCESS]: false,
					[NAMZU.TOOL_ERROR]: msg,
				})
				span.setStatus({ code: SpanStatusCode.ERROR, message: msg })
				span.end()
				return {
					success: false,
					output: '',
					error: msg,
				}
			}

			const mode = context.permissionContext?.mode ?? 'auto'
			if (mode === 'plan') {
				const isReadOnly = tool.isReadOnly ? tool.isReadOnly(rawInput) : false
				if (!isReadOnly) {
					const msg = `plan mode: non-read-only tool "${toolName}" blocked`
					span.setAttributes({
						[NAMZU.TOOL_SUCCESS]: false,
						[NAMZU.TOOL_ERROR]: msg,
					})
					span.setStatus({ code: SpanStatusCode.ERROR, message: msg })
					span.end()
					return {
						success: false,
						output: '',
						error: msg,
						permissionDenied: true,
						permissionMessage: msg,
					}
				}
			}

			const parseResult = tool.inputSchema.safeParse(rawInput)
			if (!parseResult.success) {
				const errorMessage = parseResult.error.issues
					.map((i) => `${i.path.join('.')}: ${i.message}`)
					.join('; ')

				// Distinguish "model sent an empty/no-arg call" from
				// "model sent partial args" — the first is most often a
				// streaming hiccup or a definition-test ping (Anthropic
				// occasionally pings tool surfaces with `{}` while the
				// schema is still loading), the second is a genuine
				// programming mistake by the model. The model self-
				// corrects MUCH more reliably when the error tells it
				// (a) which fields are required, (b) their types, and
				// (c) a minimal example call. Without these hints the
				// downstream UI just shows a red "Failed" row and the
				// model rarely retries with the right args.
				const isEmptyInput =
					rawInput === null ||
					rawInput === undefined ||
					(typeof rawInput === 'object' &&
						!Array.isArray(rawInput) &&
						Object.keys(rawInput as Record<string, unknown>).length === 0)

				const requiredHint = describeRequiredInput(tool.inputSchema)

				const enrichedMessage = isEmptyInput
					? `Tool "${toolName}" was called with no arguments. ${requiredHint} Retry the call with the required parameters populated.`
					: `Validation failed for "${toolName}": ${errorMessage}. ${requiredHint}`

				this.log.error(`Tool input validation failed: ${toolName}`, {
					errors: errorMessage,
					empty: isEmptyInput,
				})

				span.setAttributes({
					[NAMZU.TOOL_SUCCESS]: false,
					[NAMZU.TOOL_ERROR]: `Validation: ${errorMessage}`,
				})
				span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage })
				span.end()

				return {
					success: false,
					output: '',
					error: enrichedMessage,
				}
			}

			const finalInput = parseResult.data

			try {
				this.log.debug(`Executing tool: ${toolName}`)
				const result = await tool.execute(finalInput, context)
				this.log.debug(`Tool completed: ${toolName}`, {
					success: result.success,
				})

				span.setAttribute(NAMZU.TOOL_SUCCESS, result.success)
				if (!result.success && result.error) {
					span.setAttribute(NAMZU.TOOL_ERROR, result.error)
					span.setStatus({ code: SpanStatusCode.ERROR, message: result.error })
				} else {
					span.setStatus({ code: SpanStatusCode.OK })
				}

				return result
			} catch (err) {
				const errorMessage = toErrorMessage(err)
				this.log.error(`Tool execution error: ${toolName}`, {
					error: errorMessage,
				})

				span.setAttributes({
					[NAMZU.TOOL_SUCCESS]: false,
					[NAMZU.TOOL_ERROR]: errorMessage,
				})
				span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage })
				span.recordException(err instanceof Error ? err : new Error(errorMessage))

				return {
					success: false,
					output: '',
					error: `Tool "${toolName}" execution failed: ${errorMessage}`,
				}
			} finally {
				span.end()
			}
		})
	}

	private getByAvailability(states: ToolAvailability[], filter?: string[]): ToolDefinition[] {
		const candidates = filter ? filter.map((n) => this.getOrThrow(n)) : this.getAll()
		return candidates.filter((t) => states.includes(this.getAvailability(t.name)))
	}
}

/**
 * One-line discoverability hint for a deferred tool: the first sentence of
 * its description, capped at ~100 chars. Used for the `<deferred_tools>`
 * prompt listing and for `search_tools` near-miss suggestions, where the
 * full description would re-import the token weight deferral avoids.
 */
export function toolDiscoveryHint(description: string, maxLength = 100): string {
	const normalized = description.trim().replace(/\s+/g, ' ')
	if (normalized.length === 0) return ''
	const sentenceMatch = normalized.match(/^.*?[.!?](?=\s|$)/)
	const sentence = sentenceMatch ? sentenceMatch[0] : normalized
	if (sentence.length <= maxLength) return sentence
	return `${sentence.slice(0, maxLength - 1).trimEnd()}…`
}

/**
 * Lower-cased argument (property) names of a tool's input schema, used by
 * `searchDeferred` ranking. Walks the JSON-Schema rendering (already a
 * registration dependency) instead of Zod internals; opaque schemas simply
 * contribute no argument matches.
 */
function listArgumentNames(tool: ToolDefinition): string[] {
	try {
		const json = zodToJsonSchema(tool.inputSchema, {
			target: 'jsonSchema7',
			$refStrategy: 'none',
		}) as { properties?: Record<string, unknown> }
		return Object.keys(json.properties ?? {}).map((key) => key.toLowerCase())
	} catch {
		return []
	}
}

/**
 * Build a one-sentence "Required: <field>: <type>, <field>: <type>"
 * hint from a Zod schema, used to enrich tool-input validation
 * errors so the model can self-correct without round-tripping the
 * full JSON schema again. Walks the schema's JSON-Schema rendering
 * (already a dependency for tool registration) so we don't have to
 * branch over Zod's internal type tree.
 *
 * Returns a fallback string for opaque/non-object schemas — the
 * caller still ships the raw Zod issues separately, so the hint
 * here is bonus context, not the only signal.
 */
function describeRequiredInput(schema: { _def?: unknown }): string {
	try {
		const json = zodToJsonSchema(schema as never) as {
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
