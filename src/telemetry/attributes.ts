export { GENAI, NAMZU } from '../constants/telemetry/index.js'

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
