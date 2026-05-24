/**
 * Shared TUI types — kept rendering-agnostic so the slash parser and
 * agent adapter (which we unit-test) can speak them without pulling in
 * the React/Ink layer.
 */

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface TranscriptMessage {
	readonly id: string
	readonly role: MessageRole
	readonly content: string
	readonly pending?: boolean
}

export interface TuiContext {
	readonly cwd: string
	readonly version: string
}
