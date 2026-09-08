import type { z } from 'zod'

/**
 * Configuration for validated output via tool constraint or native JSON Schema.
 *
 * This configuration allows an agent to produce validated, typed output by
 * presenting the output schema as a tool by default, or as a native response format.
 */
export interface StructuredOutputConfig<TSchema extends z.ZodType = z.ZodType> {
	/**
	 * The Zod schema that defines the output structure.
	 * Used for both validation and LLM tool schema generation.
	 */
	schema: TSchema

	/** Default tool constraint, or native JSON schema on an explicitly capable driver. */
	mode?: 'tool' | 'native'

	/**
	 * Turns spent re-prompting when the model answers in prose or fails
	 * validation. Defaults to {@link DEFAULT_STRUCTURED_OUTPUT_RETRIES}.
	 *
	 * Bounded so a model that cannot satisfy the schema fails loudly rather
	 * than iterating against `maxIterations`.
	 */
	maxRetries?: number

	/** Review the JSON-decoded result before settlement. Narrow the value before use: serialization may change schema output types. Exceptions fail the run; cancellation is propagated. */
	review?: (
		output: unknown,
		context: import('../run/answer-review.js').AnswerReviewContext,
	) =>
		| import('../run/answer-review.js').AnswerReview
		| Promise<import('../run/answer-review.js').AnswerReview>
	/** Corrections allowed after host rejection, separate from schema retries. Default 3; zero allows no correction. */
	maxReviews?: number
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
