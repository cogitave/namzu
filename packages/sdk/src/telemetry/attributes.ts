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

	TOOL_NAME: 'gen_ai.tool.name',
	TOOL_TYPE: 'gen_ai.tool.type',
	TOOL_CALL_ID: 'gen_ai.tool.call_id',

	AGENT_NAME: 'gen_ai.agent.name',
	AGENT_ID: 'gen_ai.agent.id',
} as const

export const NAMZU = {
	SESSION_ID: 'namzu.session.id',
	SESSION_STATUS: 'namzu.session.status',
	ITERATION: 'namzu.iteration',
	TOOL_SUCCESS: 'namzu.tool.success',
	TOOL_ERROR: 'namzu.tool.error',
	COST_TOTAL: 'namzu.cost.total',
	CACHE_READ_TOKENS: 'namzu.cache.read_tokens',
	CACHE_WRITE_TOKENS: 'namzu.cache.write_tokens',
	CACHE_DISCOUNT: 'namzu.cache.discount',
} as const

export function agentSessionSpanName(agentName: string): string {
	return `namzu.agent.session ${agentName}`
}

export function agentIterationSpanName(iteration: number): string {
	return `namzu.agent.iteration ${iteration}`
}

export function chatSpanName(model: string): string {
	return `chat ${model}`
}

export function toolSpanName(toolName: string): string {
	return `namzu.tool.execute ${toolName}`
}
