/**
 * The one status mark a conversation row shows. It is derived from facts the app holds (a turn
 * is running, a request waits for the person, the last turn failed, a finished turn is unread),
 * never from anything the model wrote. Each kind has a text equivalent, so no state is colour alone.
 */
export type ConversationGlyphKind =
	| 'question'
	| 'permission'
	| 'running'
	| 'error'
	| 'unread'
	| 'idle'

export interface ConversationGlyph {
	kind: ConversationGlyphKind
	/** The words for the mark: the accessible name, the tooltip and the row's status line. */
	label: string
}

/** The tool a model uses to put a question to the person; its request is not a permission. */
const QUESTION_TOOL = 'ask_user_question'

const LABELS: Record<ConversationGlyphKind, string> = {
	question: 'Question waiting',
	permission: 'Approval needed',
	running: 'Running',
	error: 'Needs attention',
	unread: 'New reply',
	idle: '',
}

export interface ConversationGlyphFacts {
	/** Requests waiting for the person, as the conversation holds them. */
	permissions: readonly { calls: readonly { name: string }[] }[]
	/** A turn is running and has not been stopped. */
	running: boolean
	/** The last turn ended in an error. */
	error: boolean
	/** A turn finished while no window showed this conversation. */
	unread: boolean
}

/**
 * Needs the person first, then work in progress, then what went wrong, then what is new.
 * A conversation that is none of these has no mark at all.
 */
export function conversationGlyph(facts: ConversationGlyphFacts): ConversationGlyph {
	const kind = glyphKind(facts)
	return { kind, label: LABELS[kind] }
}

function glyphKind(facts: ConversationGlyphFacts): ConversationGlyphKind {
	if (facts.permissions.length > 0)
		return facts.permissions.some((request) =>
			request.calls.some((call) => call.name === QUESTION_TOOL),
		)
			? 'question'
			: 'permission'
	if (facts.running) return 'running'
	if (facts.error) return 'error'
	if (facts.unread) return 'unread'
	return 'idle'
}
