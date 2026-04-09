import { createHash } from 'node:crypto'

export function hashToolResult(toolName: string, input: unknown, output: string): string {
	const data = JSON.stringify({ toolName, input, output })
	return createHash('sha256').update(data).digest('hex').slice(0, 16)
}

export function buildToolResultHashes(
	toolResults: Array<{ toolCallId: string; toolName: string; input: unknown; output: string }>,
): Record<string, string> {
	const hashes: Record<string, string> = {}
	for (const result of toolResults) {
		hashes[result.toolCallId] = hashToolResult(result.toolName, result.input, result.output)
	}
	return hashes
}
