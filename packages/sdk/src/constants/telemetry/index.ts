export const GENAI = {
	OPERATION_NAME: 'gen_ai.operation.name',
	SYSTEM: 'gen_ai.system',

	REQUEST_MODEL: 'gen_ai.request.model',
	REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
	REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',

	RESPONSE_MODEL: 'gen_ai.response.model',
	RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
	RESPONSE_ID: 'gen_ai.response.id',

	USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
	USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',

	/**
	 * Which kind of token a usage measurement counts. The convention keys
	 * one metric by this rather than minting a metric name per kind, so a
	 * dashboard that sums the metric gets the whole picture instead of one
	 * slice of it.
	 */
	TOKEN_TYPE: 'gen_ai.token.type',

	TOOL_NAME: 'gen_ai.tool.name',
	TOOL_TYPE: 'gen_ai.tool.type',

	/**
	 * The id of the tool call this span is about.
	 *
	 * Spelled `call.id`, matching the registry and matching the two
	 * neighbours above — this read `gen_ai.tool.call_id`, one underscore
	 * where the convention has a dot, so a consumer grouping by the
	 * conventional name found nothing under it. Nothing errored, because a
	 * span attribute is a free-form key and a wrong one is simply a key
	 * nobody asked for.
	 *
	 * Pinned by `telemetry/__tests__/tool-call-id-attribute.test.ts`, which
	 * also drives the emitter: the spelling was only half the defect, and
	 * the constant had no writer at all.
	 */
	TOOL_CALL_ID: 'gen_ai.tool.call.id',

	AGENT_NAME: 'gen_ai.agent.name',
	AGENT_ID: 'gen_ai.agent.id',
} as const

export const NAMZU = {
	RUN_ID: 'namzu.run.id',
	RUN_STATUS: 'namzu.run.status',
	ITERATION: 'namzu.iteration',
	TOOL_SUCCESS: 'namzu.tool.success',
	TOOL_ERROR: 'namzu.tool.error',
	COST_TOTAL: 'namzu.cost.total',
	CACHE_READ_TOKENS: 'namzu.cache.read_tokens',
	CACHE_WRITE_TOKENS: 'namzu.cache.write_tokens',
	CACHE_DISCOUNT: 'namzu.cache.discount',
} as const
