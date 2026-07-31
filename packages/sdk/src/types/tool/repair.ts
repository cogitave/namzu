import type { ToolCall } from '../message/index.js'
import type { ToolDefinition } from './index.js'

/**
 * Why a tool call could not be executed as issued.
 *
 * `invalid_json` — the arguments string is not parseable JSON at all,
 *   typically a truncated stream or an unescaped quote.
 * `schema_validation` — the JSON parsed but does not satisfy the tool's
 *   schema: a missing required field, a string where a number belongs.
 * `unknown_tool` — the model named a tool that is not registered, usually
 *   a near-miss on a real name.
 */
export type ToolCallRepairReason = 'invalid_json' | 'schema_validation' | 'unknown_tool'

export interface ToolCallRepairContext {
	/** The call as the model issued it, arguments still raw. */
	readonly toolCall: ToolCall
	readonly reason: ToolCallRepairReason
	/** The error the model would otherwise have been shown. */
	readonly message: string
	/** The target tool. Absent for `unknown_tool`. */
	readonly tool?: ToolDefinition
	/** The tool's JSON Schema, so a repair model has something to aim at. */
	readonly jsonSchema?: Record<string, unknown>
	/** Every registered tool name — the useful context for `unknown_tool`. */
	readonly availableTools: readonly string[]
}

/**
 * Fix a tool call the model got wrong, before the error reaches it.
 *
 * A malformed call used to cost a full round trip: the error went back as
 * a `tool_result`, the model read it, and tried again — a second inference
 * on the entire context to fix a missing brace. A host that can repair the
 * arguments locally (a cheap model with the schema, or plain string
 * surgery) turns that into nothing.
 *
 * Return the corrected call, or `null` to decline — declining is not a
 * failure, it just means the original error proceeds to the model as
 * before. Deliberately narrow: a repair may rewrite the ARGUMENTS and the
 * tool NAME, and nothing else. It cannot invent a call the model never
 * made, and it cannot suppress one.
 */
export type RepairToolCall = (
	context: ToolCallRepairContext,
) => Promise<ToolCallRepair | null> | ToolCallRepair | null

export interface ToolCallRepair {
	/** Corrected arguments, as a JSON string. */
	readonly arguments: string
	/** Corrected tool name. Omit to keep the one the model used. */
	readonly toolName?: string
}
