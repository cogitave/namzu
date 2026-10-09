import type { AttachmentView } from './protocol.js'

/**
 * The model-facing prompt the host sends is the person's text followed by one
 * block per attachment: `Attached text file: "name"` then the file's text, or
 * `Attached image: "name"`. A reloaded conversation only has that text, so the
 * blocks are read back into chips and the person's own words.
 */
const MARKER = /(?:^|\n\n)Attached (text file|image): ("(?:[^"\\]|\\.)*")(?=\n|$)/g

export interface SplitPrompt {
	text: string
	attachments: AttachmentView[]
}

export function splitAttachmentWrapper(prompt: string, idPrefix: string): SplitPrompt {
	const found: { kind: 'text' | 'image'; name: string; start: number; bodyStart: number }[] = []
	for (const match of prompt.matchAll(MARKER)) {
		let name: unknown
		try {
			name = JSON.parse(match[2] ?? '')
		} catch {
			continue
		}
		if (typeof name !== 'string') continue
		const start = match.index ?? 0
		found.push({
			kind: match[1] === 'image' ? 'image' : 'text',
			name,
			start,
			bodyStart: start + match[0].length,
		})
	}
	if (!found.length) return { text: prompt, attachments: [] }
	const attachments = found.map((block, index): AttachmentView => {
		const end = found[index + 1]?.start ?? prompt.length
		// A text file's body follows the marker line after one newline.
		const body = block.kind === 'text' ? prompt.slice(block.bodyStart + 1, end) : ''
		return {
			id: `${idPrefix}-${index}`,
			name: block.name,
			kind: block.kind,
			size: block.kind === 'text' ? new TextEncoder().encode(body).length : 0,
			mediaType: block.kind === 'text' ? 'text/plain' : 'image/*',
		}
	})
	return { text: prompt.slice(0, found[0]?.start ?? 0), attachments }
}
