import { findSecretShape } from '../../store/memory/secrets.js'
import type { ToolResult } from '../../types/tool/index.js'

/**
 * A refusal when any field a model is saving holds a secret, else `undefined`.
 * The reply names the shape, never the text, so the refusal does not repeat
 * the secret into the transcript.
 */
export function refuseSecret(fields: readonly (string | undefined)[]): ToolResult | undefined {
	for (const field of fields) {
		if (field === undefined) continue
		const shape = findSecretShape(field)
		if (shape === undefined) continue
		return {
			success: false,
			output:
				'The memory looks like it contains a secret (an API key, token, password, private key or a URL with credentials). Memories are recalled into later prompts and kept on disk in the clear, so it was not saved. Save where the secret lives (the variable or file name) instead of its value.',
			error: 'Memory content rejected',
			data: { reason: 'secret', shape },
		}
	}
	return undefined
}
