import type { z } from 'zod'
import type { Logger } from '../../utils/logger.js'
import type { RunId } from '../ids/index.js'
import type { PermissionMode } from '../permission/index.js'

export interface ToolRegistryRef {
	searchDeferred(query: string): ToolDefinition[]
	activate(names: string[]): void
	getAvailability(name: string): ToolAvailability
}

export interface ToolContext {
	runId: RunId
	workingDirectory: string
	abortSignal: AbortSignal
	env: Record<string, string>
	log: (level: 'info' | 'warn' | 'error', message: string) => void
	permissionContext?: {
		mode: PermissionMode
		sessionId: string
		workingDirectory: string
	}

	toolRegistry?: ToolRegistryRef
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
