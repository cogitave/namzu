import { useSyncExternalStore } from 'react'
import type { CodePrefs } from './code-prefs.js'

/**
 * Colours for the code blocks of a reply. The caller hands in a loader for the highlighter, so the
 * rules here (which blocks are drawn, in which theme, what is cached) run in tests with a fake one.
 */

/** A block longer than this many characters stays plain text. */
export const MAX_HIGHLIGHT_CHARS = 20_000
/** A block with more lines than this stays plain text. */
export const MAX_HIGHLIGHT_LINES = 500

export interface HighlightToken {
	content: string
	color?: string
}

export interface HighlightEngine {
	codeToTokens(
		code: string,
		options: { lang: string; theme: string },
	): { tokens: HighlightToken[][] }
}

/** Loads the highlighter with a theme and a language ready; rejects for a language it does not know. */
export type EngineLoader = (theme: string, lang: string) => Promise<HighlightEngine>

/** The theme for the window's current appearance, from the two the Settings rows choose. */
export function themeForMode(prefs: CodePrefs, dark: boolean): string {
	return dark ? prefs.dark : prefs.light
}

/**
 * Whether a block of a reply may be coloured. Only the tail of a streaming reply can still change, so
 * a finished reply, a document, and every block before the tail are settled; the tail stays plain
 * until the reply is done, so a growing reply is never highlighted again on each update.
 */
export function blockIsSettled(
	index: number,
	count: number,
	replySettled: boolean,
	isDocument: boolean,
): boolean {
	return replySettled || isDocument || index < count - 1
}

/** Whether a block of Markdown may hold a fenced code block, the only kind that is coloured. */
export function hasFence(block: string): boolean {
	return block.includes('```') || block.includes('~~~')
}

const PLAIN_LANGUAGES = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'ansi'])

/**
 * The language a fence names, ready for the highlighter, or undefined when the block stays plain:
 * no language, plain text, a name that is not a plain identifier, or a block over the size caps.
 * The highlighter resolves its own aliases (ts, sh, py and so on); an unknown name fails there.
 */
export function highlightLanguage(text: string, fence: string): string | undefined {
	const lang = fence.trim().toLowerCase()
	if (PLAIN_LANGUAGES.has(lang) || !/^[a-z0-9][a-z0-9_+#.-]*$/.test(lang)) return undefined
	if (text.length > MAX_HIGHLIGHT_CHARS) return undefined
	let lines = 1
	for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
		if (++lines > MAX_HIGHLIGHT_LINES) return undefined
	}
	return lang
}

function isUnknownLanguage(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error)
	return (
		/language/i.test(message) &&
		/(not found|unknown|not (?:been )?(?:loaded|registered|supported))/i.test(message)
	)
}

export interface BlockHighlighter {
	/** Lines of coloured tokens, or undefined when the block stays plain. */
	highlight(text: string, fence: string, theme: string): Promise<HighlightToken[][] | undefined>
}

export function createBlockHighlighter(load: EngineLoader): BlockHighlighter {
	// One load per theme and language: a failure is remembered too, so a bad name is asked once.
	const engines = new Map<string, Promise<HighlightEngine | undefined>>()
	return {
		async highlight(text, fence, theme) {
			const lang = highlightLanguage(text, fence)
			if (!lang) return undefined
			const key = `${theme}\u0000${lang}`
			let engine = engines.get(key)
			if (!engine) {
				engine = load(theme, lang).then(
					(loaded) => loaded,
					(error: unknown) => {
						// Only an unknown language is remembered; a load that failed for another reason is tried again.
						if (!isUnknownLanguage(error)) engines.delete(key)
						return undefined
					},
				)
				engines.set(key, engine)
			}
			const ready = await engine
			if (!ready) return undefined
			try {
				const { tokens } = ready.codeToTokens(text, { lang, theme })
				// The tokens must spell the original text, or the block stays as written.
				const spelled = tokens.map((line) => line.map((token) => token.content).join('')).join('\n')
				return spelled === text ? tokens : undefined
			} catch {
				return undefined
			}
		},
	}
}

/** Whether the window is drawn dark: the root carries the `dark` class (workspace-host.tsx). */
function windowIsDark(): boolean {
	return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

function subscribeWindowDark(listener: () => void): () => void {
	if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
	const observer = new MutationObserver(listener)
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
	return () => observer.disconnect()
}

/** True while the window is dark; redraws when it switches. */
export function useWindowDark(): boolean {
	return useSyncExternalStore(subscribeWindowDark, windowIsDark, () => false)
}
