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

/**
 * A short, stable digest of any JSON-able value.
 *
 * `JSON.stringify` is not stable across key insertion order, so callers
 * that need two equal-by-content values to hash alike must normalise
 * first. The one caller that does — the request envelope — sorts its tool
 * list before hashing, because the ORDER of the tool array is itself part
 * of what the model sees and a re-ordered catalogue is a real change.
 */
export function stableDigest(value: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify(value) ?? 'null')
		.digest('hex')
		.slice(0, 16)
}
