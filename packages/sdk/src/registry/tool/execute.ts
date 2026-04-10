import { SpanStatusCode } from '@opentelemetry/api'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { getTracer } from '../../provider/telemetry/setup.js'
import { GENAI, NAMZU, toolSpanName } from '../../telemetry/attributes.js'
import type {
	LLMToolSchema,
	ToolAvailability,
	ToolContext,
	ToolDefinition,
	ToolRegistryConfig,
	ToolResult,
} from '../../types/tool/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'
import { Registry } from '../Registry.js'

export interface ToolExecutionResult extends ToolResult {
	permissionDenied?: boolean
	permissionMessage?: string
}

export class ToolRegistry extends Registry<ToolDefinition> {
	private log: Logger
	private availability: Map<string, ToolAvailability> = new Map()

	constructor(config?: ToolRegistryConfig) {
		super()
		this.log = (config?.logger ?? getRootLogger()).child({
			component: 'ToolRegistry',
		})
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
		const id = tool.name
		const state: ToolAvailability = typeof maybeTool === 'string' ? maybeTool : 'active'

		this.registerOne(id, tool, state)
	}

	private registerOne(id: string, tool: ToolDefinition, state: ToolAvailability): void {
		if (this.has(id)) {
			this.log.warn(`Tool "${id}" is already registered, overwriting.`)
		}
		super.register(id, tool)
		this.availability.set(id, state)
		this.log.info(`Tool registered: ${id} (${state})`)
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

	getOrThrow(name: string): ToolDefinition {
		const tool = this.get(name)
		if (!tool) {
			throw new Error(`Tool not found: "${name}". Available tools: ${this.listIds().join(', ')}`)
		}
		return tool
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

		return toolsToConvert.map((tool) => ({
			type: 'function' as const,
			function: {
				name: tool.name,
				description: tool.description,
				parameters: zodToJsonSchema(tool.inputSchema, {
					target: 'jsonSchema7',
					$refStrategy: 'none',
				}) as Record<string, unknown>,
			},
		}))
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

				this.log.error(`Tool input validation failed: ${toolName}`, {
					errors: errorMessage,
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
					error: `Invalid input for tool "${toolName}": ${errorMessage}`,
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
