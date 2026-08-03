import type { z } from 'zod'

/**
 * Configuration for structured output via tool constraint.
 *
 * This configuration allows an agent to produce validated, typed output by
 * presenting the output schema as a special tool that the model must call.
 */
export interface StructuredOutputConfig<TSchema extends z.ZodType = z.ZodType> {
	/**
	 * The Zod schema that defines the output structure.
	 * Used for both validation and LLM tool schema generation.
	 */
	schema: TSchema

	/**
	 * Turns spent re-prompting when the model answers in prose or fails
	 * validation. Defaults to {@link DEFAULT_STRUCTURED_OUTPUT_RETRIES}.
	 *
	 * Bounded so a model that cannot satisfy the schema fails loudly rather
	 * than iterating against `maxIterations`.
	 */
	maxRetries?: number
}

/**
 * Result from structured output tool execution.
 *
 * The structured_output tool returns this result after validating
 * the input against the provided schema.
 */
export interface StructuredOutputResult<T = unknown> {
	/**
	 * Whether the structured output was successfully produced.
	 * Always true for successful tool execution (validation happens at schema level).
	 */
	success: boolean

	/**
	 * The parsed and validated output data.
	 * Type is inferred from the Zod schema.
	 */
	data?: T

	/**
	 * Error message if structured output failed.
	 * This would typically come from schema validation errors
	 * that occur before tool execution.
	 */
	error?: string

	/**
	 * The raw JSON string representation of the output.
	 * Useful for logging or debugging.
	 */
	rawOutput?: string
}
