import type { ToolResultBlock, ToolResultContent } from './index.js'

/**
 * Normalize tool-result content to blocks.
 *
 * A plain string is the common case and stays first-class; this is the
 * adapter for drivers that want to walk blocks uniformly.
 */
export function toToolResultBlocks(content: ToolResultContent): readonly ToolResultBlock[] {
	return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

/**
 * Flatten tool-result content to text.
 *
 * For drivers that cannot express non-text tool results, and for every
 * host-facing surface (transcript, compaction, UI) that reasons over
 * strings. Non-text blocks become a short, honest placeholder rather than
 * their base64 payload: dumping the bytes is what made `computer-use`
 * send megabytes of undecodable characters as text, and silently dropping
 * them would let the model believe it saw something it did not.
 */
export function toolResultToText(content: ToolResultContent): string {
	if (typeof content === 'string') return content
	return content
		.map((block) => {
			switch (block.type) {
				case 'text':
					return block.text
				case 'image':
					return `[image: ${block.mediaType}, ${describeSize(block.data)} — not renderable by this provider]`
				case 'document':
					return `[document${block.name ? ` "${block.name}"` : ''}: ${block.mediaType}, ${describeSize(block.data)} — not renderable by this provider]`
			}
		})
		.join('\n')
}

/** True when the content needs a driver that can carry non-text blocks. */
export function hasNonTextBlocks(content: ToolResultContent): boolean {
	return typeof content !== 'string' && content.some((b) => b.type !== 'text')
}

/** Approximate decoded byte count of a base64 payload, for a human-readable note. */
function describeSize(base64: string): string {
	const bytes = Math.floor((base64.length * 3) / 4)
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
