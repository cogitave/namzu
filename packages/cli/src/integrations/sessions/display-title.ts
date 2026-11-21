import type { Message } from '@namzu/sdk'

import { chipPastedRanges } from '../../tui/paste-chips.js'

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

/**
 * The title to show for a conversation saved with `title`: a title made from the
 * unchipped first message (saved before chips were kept out of titles) is shown
 * as the chipped one; a title a person or the model chose is left alone.
 */
export function displayTitleFor(title: string, messages: readonly Message[]): string {
	return title === titleFromMessages(messages, false) ? titleFromMessages(messages, true) : title
}

export function titleFromMessages(messages: readonly Message[], chip: boolean): string {
	const firstHuman = messages.find(
		(message) => message.role === 'user' && message.source === undefined,
	)
	const firstGoal = messages.find(
		(message) => message.role === 'user' && message.source?.type === 'goal-round',
	)
	const raw =
		firstHuman?.role === 'user'
			? chip
				? chipPastedRanges(firstHuman.content, firstHuman.pasted)
				: firstHuman.content
			: firstGoal?.role === 'user' && firstGoal.source?.type === 'goal-round'
				? firstGoal.source.objective
				: 'Conversation'
	const typed = typedTextOf(raw)
	const text = (typed.text.trim() ? typed.text : (typed.firstFile ?? ''))
		.replace(/\s+/g, ' ')
		.trim()
	return text.length > 60 ? `${text.slice(0, 59)}…` : text || 'Conversation'
}
