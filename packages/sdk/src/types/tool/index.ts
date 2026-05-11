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
 * (Claude Code parity): an existing file must be read first or the write fails.
 * Keys are the resolved path used by the tool — sandbox-relative when a sandbox
 * is active, absolute (`workingDirectory`-resolved) otherwise.
 */
export interface FileReadTracker {
	recordRead(key: string): void
	hasRead(key: string): boolean
}

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
	sandbox?: Sandbox
	fileReadTracker?: FileReadTracker
}

export interface ToolResult {
	success: boolean
	output: string
	data?: unknown
	error?: string
}

export interface ToolDefinition<TInput = unknown> {
	name: string
	description: string
	inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>
	execute(input: TInput, context: ToolContext): Promise<ToolResult>
	tier?: string
	permissions?: ToolPermission[]
	category?: 'filesystem' | 'shell' | 'network' | 'analysis' | 'custom'

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
