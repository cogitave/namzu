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
	/** Overrides the role's default gutter glyph (e.g. a per-tool icon). */
	readonly glyph?: string
	/** Overrides the glyph color (e.g. red for a failed tool). */
	readonly glyphColor?: string
	/** Dim suffix after the content (e.g. a tool's elapsed time). */
	readonly meta?: string
	/** Collapsible body under the line (tool diff / output); see Ctrl+O. */
	readonly detail?: readonly string[]
}

export interface TuiContext {
	readonly cwd: string
	readonly version: string
	/** When true, tools run without the approval prompt (--dangerously-skip-permissions / --yolo). */
	readonly skipPermissions?: boolean
}
