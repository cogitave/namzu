import type { z } from 'zod'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import { cloneJsonValue } from '../../../utils/json-snapshot.js'

/** Native constraints are transport assistance; local validation still owns acceptance. */
export async function parseNativeCandidate(
	schema: z.ZodType,
	response: ChatCompletionResponse,
	signal: AbortSignal,
): Promise<{ success: true; value: unknown } | { success: false }> {
	signal.throwIfAborted()
	if (response.finishReason !== 'stop' || response.message.toolCalls?.length)
		return { success: false }
	let input: unknown
	try {
		input = JSON.parse(response.message.content ?? '')
	} catch {
		return { success: false }
	}
	let abort!: () => void
	const cancelled = new Promise<never>((_resolve, reject) => {
		abort = () => reject(signal.reason ?? new Error('Native output validation cancelled'))
		signal.addEventListener('abort', abort, { once: true })
	})
	try {
		const parsed = await Promise.race([schema.safeParseAsync(input), cancelled])
		signal.throwIfAborted()
		if (!parsed.success) return { success: false }
		// Match the serialized result contract of output-tool mode. Never rerun transforms.
		const value = cloneJsonValue(parsed.data, false)
		return { success: true, value }
	} finally {
		signal.removeEventListener('abort', abort)
	}
}
