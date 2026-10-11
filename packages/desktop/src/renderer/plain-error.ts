/**
 * The one way a caught error reaches the screen. A banner, dialog or toast never shows an Error's
 * name, Electron's "Error invoking remote method" prefix, an operating-system code, a stack or a
 * developer sentence. A message the product wrote for a person passes through; a known failure
 * becomes one plain sentence with a next step; anything else becomes a sentence for the action that
 * failed, and the original (cleaned) text stays behind Details. The mapping reads only text.
 */

export interface PlainError {
	/** One sentence a person can act on. */
	text: string
	/** The cleaned original, when it says something the sentence does not. */
	details?: string
}

const REMOTE_PREFIX = /^\s*Error invoking remote method '[^']*':\s*/i
const CLASS_PREFIX = /^\s*(?:[A-Za-z]+Error|Error|Exception):\s*/
const STACK_LINE = /\n\s+at\s.*$/s

/** The message without Electron's prefix, class names and any stack, as one trimmed string. */
export function cleanErrorMessage(raw: string): string {
	let text = raw.replace(STACK_LINE, '')
	for (let pass = 0; pass < 4; pass++) {
		const next = text.replace(REMOTE_PREFIX, '').replace(CLASS_PREFIX, '')
		if (next === text) break
		text = next
	}
	return text.replace(/\s+/g, ' ').trim()
}

const NEXT_STEP = 'Try again.'

const KNOWN: { match: RegExp; text: string }[] = [
	{
		match: /\bENOENT\b|no such file or directory|file not found|ERR_FILE_NOT_FOUND/i,
		text: 'That file or folder no longer exists. Choose another one.',
	},
	{
		match: /\b(?:EACCES|EPERM)\b|permission denied|access is denied|operation not permitted/i,
		text: 'Namzu isn’t allowed to open that. Check its permissions, then try again.',
	},
	{
		match: /\bEBUSY\b|resource busy|being used by another process/i,
		text: 'Another program is using that. Close it, then try again.',
	},
	{
		match: /\bENOSPC\b|no space left/i,
		text: 'The disk is full. Free some space, then try again.',
	},
	{
		match:
			/\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b|network (?:is )?(?:unreachable|error)|fetch failed/i,
		text: 'Namzu couldn’t reach the network. Check your connection, then try again.',
	},
	{
		match:
			/protocol (?:frame|response|pipe)|oversized .*frame|different terminal|descendants retained|ownership check|playback acknowledged|owned Namzu process|process tree|invalid workspace action|invalid terminal tab/i,
		text: 'Namzu ran into a problem and stopped that. Try again, or restart Namzu if it keeps happening.',
	},
	// An older host words a refusal to close or repeat a paused reply as a statement about the connection.
	{
		match: /connection cannot (?:close|resume)[a-z ]* paused turns/i,
		text: 'Namzu can’t close this reply in this conversation. Copy your message to a new conversation instead.',
	},
	{
		match: /\bunknown (?:project|conversation|pal)\b|does not belong to this (?:project|pal)/i,
		text: 'That is no longer available. Pick it again from the sidebar.',
	},
]

/** Words and shapes that mark a message as written for developers, not for a person. */
const DEVELOPER_WORDS =
	/\b(?:undefined|null|NaN|json|stack|errno|syscall|protocol|frame|pipe|descendants?|ownership|handshake|socket|spawn|exit code|namzu\/[a-z]|harness|ledger|ingress|dispatch|checkpoint)\b|\[object|[a-z]+_[a-z_]+|\bat [^ ]+:\d+|0x[0-9a-f]{4,}|\b[0-9a-f]{8}-[0-9a-f]{4}-/i
/** Operating-system and library codes are upper case; matching them case-sensitively spares "Every". */
/** A path, URL or status-code phrase is a developer's detail; it belongs behind Details. */
const TECHNICAL = /[A-Za-z]:[\\/]|\\\\|(?:^|\s)\/[\w.-]+\/|https?:\/\/|status code|\bwin32\b/i
const CODES = /\b(?:E[A-Z]{3,}|ERR_[A-Z_]+|SIG[A-Z]+|RPC|IPC|ACP|JSON)\b/

/** True when the message reads as a sentence the product wrote for a person. */
export function isPlainMessage(whole: string): boolean {
	// A quoted file or project name is the person's own word, whatever characters it holds.
	const text = whole.replace(/“[^”]*”/g, '“name”')
	if (whole.length < 8 || whole.length > 260) return false
	if (!/^[A-Z“"‘']/.test(text)) return false
	if (!/[.!?”’)]$/.test(text)) return false
	if (/\bError\b/.test(text)) return false
	return !DEVELOPER_WORDS.test(text) && !CODES.test(text) && !TECHNICAL.test(text)
}

function fallback(context: string | undefined): string {
	const action = context?.trim().replace(/[.\s]+$/, '')
	return action ? `Couldn’t ${action}. ${NEXT_STEP}` : `That didn’t work. ${NEXT_STEP}`
}

/**
 * `context` completes "Couldn’t …": the action that failed, in the person's words ("rename the
 * project", "load your Pals").
 */
export function plainError(error: unknown, context?: string): PlainError {
	const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
	const cleaned = cleanErrorMessage(raw)
	const known = KNOWN.find((item) => item.match.test(cleaned))
	if (known) return { text: known.text, ...(cleaned ? { details: cleaned } : {}) }
	if (isPlainMessage(cleaned)) return { text: cleaned }
	return { text: fallback(context), ...(cleaned ? { details: cleaned.slice(0, 500) } : {}) }
}

const RAW_MARKERS =
	/Error invoking remote method|^\s*(?:[A-Za-z]+Error|Error|Exception):|\n\s+at\s|\[object|\bundefined\b|\bnull\b|\bNaN\b/

/**
 * A last defence for a sentence that arrives already built (project.error, a stored failure): it
 * stays as it is unless it carries a raw marker, then it goes through `plainError`.
 */
export function ensurePlain(text: string, context?: string): PlainError {
	const known = KNOWN.some((item) => item.match.test(text))
	return RAW_MARKERS.test(text) || CODES.test(text) || known ? plainError(text, context) : { text }
}

/** `plainError(...).text`, for the places that carry only a sentence. */
export function plainErrorText(error: unknown, context?: string): string {
	return plainError(error, context).text
}
