/**
 * Shared TUI types — kept rendering-agnostic so the slash parser and
 * agent adapter (which we unit-test) can speak them without pulling in
 * the React/Ink layer.
 */

import type { VerificationRule } from '@namzu/sdk'

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
	/**
	 * The operator's `permissions` table, compiled to kernel rules.
	 *
	 * A config file belongs to the user, not to a command: someone who writes
	 * `bash = "deny"` and then types `namzu` expects it to hold. Interactive
	 * mode having a human present is an argument about the default, not a
	 * licence to drop a rule they wrote — and `deny` in a session means "do not
	 * even ask me", which is exactly what protects someone from approving by
	 * reflex.
	 */
	readonly rules?: readonly VerificationRule[]
}
