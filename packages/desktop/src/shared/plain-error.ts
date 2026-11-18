/**
 * The one way a caught error reaches the screen. A banner, dialog or toast never shows an Error's
 * name, Electron's "Error invoking remote method" prefix, an operating-system code, a stack or a
 * developer sentence. A message the product wrote for a person passes through; a known failure
 * becomes one plain sentence with a next step; anything else becomes a sentence for the action that
 * failed, and the original (cleaned) text stays behind Details. The mapping reads only text.
 */

import { NAMED_FAILURE_SENTENCES, namedFailureSentence } from './named-failures.js'

export interface PlainError {
	/** One sentence a person can act on. */
	text: string
	/** The cleaned original, when it says something the sentence does not. */
	details?: string
}

/**
 * What a failed engine request carries to the screen: the sentence for its stable code (or the
 * one an older engine's text stands for), otherwise the message as it came. Provider failures keep
 * their own shape here because the renderer reads them for the provider, status and next step.
 */
export function engineFailureText(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error)
	return engineCodeSentence(engineErrorCode(error) ?? engineCodeFromText(raw)) ?? raw
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

/**
 * What a person reads for each stable code the engine attaches to a failure (the JSON-RPC error's
 * `data.code`). The engine words the same sentences itself for other front ends; Desktop prefers
 * the code so a reworded engine sentence never changes what is shown here.
 */
export const ENGINE_CODE_SENTENCES: Readonly<Record<string, string>> = {
	'no-provider':
		'Namzu has no AI service set up on this computer yet. Add a key or sign in to one in Settings, then send again.',
	'connection-closed':
		'Namzu lost its connection to this conversation. Try again, or restart Namzu if it keeps happening.',
	'folder-not-trusted': 'Trust this folder first, then send again.',
	'conversation-in-other-folder':
		'This conversation is already open in another folder. Open it again from the sidebar.',
	'conversation-opening': 'This conversation is still opening. Wait a moment, then try again.',
	'message-not-sent': 'Your message wasn’t sent. Send it again.',
	'too-many-messages': 'Namzu is busy with too many messages. Wait a moment, then send again.',
	'permission-mode-needed':
		'Namzu can’t restore the approval settings for this reply. Choose how much Namzu may do, then try again.',
}

/** The code an engine attached to a failure, when the error carries one. */
export function engineErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== 'object') return undefined
	const code = (error as { engineCode?: unknown }).engineCode
	return typeof code === 'string' ? code : undefined
}

/** The sentence for an engine code; undefined for a code this Desktop does not know. */
export function engineCodeSentence(code: string | undefined): string | undefined {
	return code ? ENGINE_CODE_SENTENCES[code] : undefined
}

/**
 * Engines older than the codes word these in their own technical text. Each is matched here and
 * given the same sentence a code would, so an older engine reads the same as a current one.
 */
const OLD_ENGINE_TEXT: { match: RegExp; code: string }[] = [
	{ match: /no LLM provider is available/i, code: 'no-provider' },
	{ match: /ACP connection (?:has )?closed/i, code: 'connection-closed' },
	{ match: /^folder not trusted$/i, code: 'folder-not-trusted' },
	{ match: /ACP session ".*" already owns/i, code: 'conversation-in-other-folder' },
	{ match: /ACP session ".*" is already being constructed/i, code: 'conversation-opening' },
	{ match: /live prompt is no longer available.*not admitted/i, code: 'message-not-sent' },
	{ match: /live input mailbox is full/i, code: 'too-many-messages' },
	{ match: /explicit permission mode is required/i, code: 'permission-mode-needed' },
]

/** The code an older engine's sentence stands for. */
export function engineCodeFromText(message: string): string | undefined {
	return OLD_ENGINE_TEXT.find((entry) => entry.match.test(message))?.code
}

const KNOWN: { match: RegExp; text: string }[] = [
	{ match: /invalid undo status/i, text: NAMED_FAILURE_SENTENCES['undo-status-invalid'] },
	{
		match: /provider.*not configured/i,
		text: NAMED_FAILURE_SENTENCES['provider-not-configured'],
	},
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
		text: 'Namzu can’t close this reply right now. Try again in a moment, or restart Namzu if it keeps happening.',
	},
	{
		match: /\bunknown (?:project|conversation|pal)\b|does not belong to this (?:project|pal)/i,
		text: 'That is no longer available. Pick it again from the sidebar.',
	},
]

/** Words and shapes that mark a message as written for developers, not for a person. */
const DEVELOPER_WORDS =
	/\b(?:undefined|null|NaN|json|stack|errno|syscall|protocol|frame|pipe|descendants?|ownership|handshake|socket|spawn|exit code|namzu\/[a-z]|harness|ledger|ingress|dispatch|checkpoint|LLM|credentials?|mcp|mailbox|admitted|session ids?|ACP|stderr|stdout)\b|\[object|[a-z]+_[a-z_]+|\bat [^ ]+:\d+|0x[0-9a-f]{4,}|\b[0-9a-f]{8}-[0-9a-f]{4}-/i
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
export function plainError(error: unknown, context?: string, operation?: string): PlainError {
	const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
	const cleaned = cleanErrorMessage(raw)
	const coded = engineCodeSentence(engineErrorCode(error) ?? engineCodeFromText(cleaned))
	if (coded) return { text: coded, ...(cleaned && cleaned !== coded ? { details: cleaned } : {}) }
	const known = KNOWN.find((item) => item.match.test(cleaned))
	if (known) return { text: known.text, ...(cleaned ? { details: cleaned } : {}) }
	if (isPlainMessage(cleaned)) return { text: cleaned }
	// A read that failed without a sentence of its own is named by what it was reading.
	const named = namedFailureSentence(cleaned, operation)
	if (named) return { text: named, ...(cleaned ? { details: cleaned.slice(0, 500) } : {}) }
	return { text: fallback(context), ...(cleaned ? { details: cleaned.slice(0, 500) } : {}) }
}

const RAW_MARKERS =
	/Error invoking remote method|^\s*(?:[A-Za-z]+Error|Error|Exception):|\n\s+at\s|\[object|\bundefined\b|\bnull\b|\bNaN\b/

/** Words a person never reads in a sentence: the sentence is rebuilt, the original kept in Details. */
const STOP_WORDS =
	/\b(?:LLM|credentials?|mailbox|admitted|exit code|protocol|handshake|session ids?)\b/i

/**
 * A last defence for a sentence that arrives already built (project.error, a stored failure): it
 * stays as it is unless it carries a raw marker, then it goes through `plainError`.
 */
export function ensurePlain(text: string, context?: string): PlainError {
	const known =
		KNOWN.some((item) => item.match.test(text)) || engineCodeFromText(text) !== undefined
	return RAW_MARKERS.test(text) || CODES.test(text) || STOP_WORDS.test(text) || known
		? plainError(text, context)
		: { text }
}

/** `plainError(...).text`, for the places that carry only a sentence. */
export function plainErrorText(error: unknown, context?: string, operation?: string): string {
	return plainError(error, context, operation).text
}
