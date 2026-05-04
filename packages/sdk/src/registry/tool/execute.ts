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

	searchDeferred(query: string): ToolDefinition[] {
		const q = query.toLowerCase()
		return this.getByAvailability(['deferred']).filter(
			(t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
		)
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

		if (active.length > 0) {
			const entries = active.map((t) => `- ${t.name}: ${t.description}`).join('\n')
			parts.push(`<available_tools>\n${entries}\n</available_tools>`)
		}

		if (deferred.length > 0) {
			const entries = deferred.map((t) => `- ${t.name}`).join('\n')
			parts.push(
				`<deferred_tools>\nUse search_tools to load these before use:\n${entries}\n</deferred_tools>`,
			)
		}

		if (parts.length === 0) return ''
		return parts.join('\n\n')
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

			// Truncation sentinel — the iteration loop's post-stream
			// flush stamps this on tool calls whose args were cut off
			// mid-`input_json_delta` (Anthropic max_tokens-mid-literal
			// cutoff is the canonical case). Short-circuit to a model-
			// readable error so the model can retry with shorter input
			// instead of receiving a generic Zod failure that suggests
			// it called the tool incorrectly.
			if (
				rawInput &&
				typeof rawInput === 'object' &&
				(rawInput as Record<string, unknown>).__namzuTruncated === true
			) {
				const partial = String(
					(rawInput as Record<string, unknown>).partialBuffer ?? '',
				).slice(0, 80)
				const truncMsg = `Tool "${toolName}" call was cut off by the model's output token limit (the JSON arguments stopped mid-stream). The tool was NOT executed. Retry with shorter input — for a Write tool, split the content into multiple smaller calls; for any tool, reduce the size of arguments. Partial buffer for context: ${partial}…`
				this.log.warn(`Tool input truncated by upstream cutoff: ${toolName}`, {
					bufferPreview: partial,
				})
				span.setAttributes({
					[NAMZU.TOOL_SUCCESS]: false,
					[NAMZU.TOOL_ERROR]: 'truncated-upstream',
				})
				span.setStatus({ code: SpanStatusCode.ERROR, message: 'truncated-upstream' })
				span.end()
				return {
					success: false,
					output: '',
					error: truncMsg,
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
