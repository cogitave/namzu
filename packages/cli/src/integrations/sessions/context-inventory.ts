import type { Message, PrepareStep } from '@namzu/sdk'

/** What a cleared tool result starts with. */
const CLEARED_RESULT_PREFIX = '[tool output cleared]'

/** Whether a compaction replaced messages with a summary or cleared a tool result. */
function compacted(messages: readonly Message[]): boolean {
	return messages.some(
		(message) =>
			(message.role === 'system' && message.source?.type === 'compaction-summary') ||
			(message.role === 'tool' &&
				typeof message.content === 'string' &&
				message.content.startsWith(CLEARED_RESULT_PREFIX)),
	)
}

/** A bounded, ephemeral map of the visible working set; no payload copies or inference. */
export function createContextInventoryStep(): PrepareStep {
	return ({ messages, contextBudget, prepared, signal }) => {
		signal?.throwIfAborted()
		const blocks: { position: number; chars: number; images: number; pinned: boolean }[] = []
		let totalChars = 0
		let imageCount = 0
		for (const [position, message] of messages.entries()) {
			if (message.role !== 'tool') continue
			let chars = 0
			let images = 0
			if (typeof message.content === 'string') chars = message.content.length
			else if (Array.isArray(message.content))
				for (const block of message.content) {
					if (block.type === 'text') chars += block.text.length
					else images++
				}
			totalChars += chars
			imageCount += images
			blocks.push({ position, chars, images, pinned: message.retain === true })
		}
		const pressure = contextBudget && contextBudget.remainingTokens < contextBudget.windowTokens / 4
		// A map of the working set earns its place only when room is short or content
		// was already shed; before that everything is in view and it is only noise.
		if (!pressure && !compacted(messages)) return undefined
		// Under extreme pressure even a useful dashboard must yield to the actual task.
		if (contextBudget && contextBudget.remainingTokens < 1_500) return undefined
		const inventory = {
			visibleMessages: messages.length,
			visibleToolTextChars: totalChars,
			visibleNonTextBlocks: imageCount,
			estimatedRemainingTokens: contextBudget?.remainingTokens,
			largestToolBlocks: blocks.sort((a, b) => b.chars - a.chars).slice(0, 6),
		}
		const text =
			'Context inventory for your own planning: not a request, and not something to mention to the user. Positions are temporary. Sizes are UTF-16 text characters; non-text payloads are counted, not estimated as base64 text tokens. Do not repeat a state-changing action to recover its output.\n' +
			JSON.stringify(inventory)
		return { context: [prepared.context, text].filter(Boolean).join('\n\n') }
	}
}
