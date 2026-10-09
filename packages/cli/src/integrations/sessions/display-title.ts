/** Preserve saved titles while replacing the old scheduled-run clock in text output. */
export function displayConversationTitle(title: string): string {
	return /^⏲ .+ · .+$/u.test(title) ? `Scheduled: ${title.slice(2)}` : title
}

/**
 * The wrapper the desktop app appends to a message for each attached file. It is
 * for the model, not for a person, so a title never carries it.
 */
const ATTACHMENT_BLOCK = /(?:^|\n\n)Attached (?:text file|image): ("(?:[^"\\\n]|\\.)*")/u

/**
 * The part of a message a person typed, and the first attached file's name for a
 * message that carried only attachments.
 */
export function typedTextOf(content: string): { text: string; firstFile?: string } {
	const match = ATTACHMENT_BLOCK.exec(content)
	if (!match) return { text: content }
	let firstFile: string | undefined
	try {
		const parsed: unknown = JSON.parse(match[1] ?? '')
		if (typeof parsed === 'string' && parsed) firstFile = parsed
	} catch {
		// A name that does not parse is simply not offered as a title.
	}
	return { text: content.slice(0, match.index), ...(firstFile ? { firstFile } : {}) }
}
