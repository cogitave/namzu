export { GENAI, NAMZU } from '../constants/telemetry/index.js'

export function agentRunSpanName(agentName: string): string {
	return `namzu.agent.run ${agentName}`
}

export function agentIterationSpanName(iteration: number): string {
	return `namzu.agent.iteration ${iteration}`
}

export function toolSpanName(toolName: string): string {
	return `namzu.tool.execute ${toolName}`
}
