/**
 * Shared TUI types — kept rendering-agnostic so the slash parser and
 * agent adapter (which we unit-test) can speak them without pulling in
 * the React/Ink layer.
 */

import type { AuthorizationRule } from '@namzu/sdk'

import type { ConfigDebugSnapshot } from '../config/debug.js'
import type { SandboxConfig, TuiConfig } from '../config/schema.js'
import type { McpServersConfig } from '../integrations/mcp/servers.js'
import type { ResolvedLogging } from '../logging.js'

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
	/** Collapsible body under the line (tool diff / output). */
	readonly detail?: readonly string[]
	/**
	 * The number this row's collapse hint prints, so `/expand <n>` can name it.
	 *
	 * Assigned once, when the row is pushed, and monotone for the life of the
	 * transcript. Deliberately NOT an index into the message list: system, user
	 * and assistant rows sit between the ones that carry detail, so an index
	 * would name a different row every time one of those arrived.
	 */
	readonly detailRef?: number
	/**
	 * This row prints its whole body, with no collapse and no hint.
	 *
	 * A property of the ROW rather than a setting on the view, and that is
	 * forced rather than chosen. Finalized rows render through Ink's `<Static>`,
	 * which renders `items.slice(index)` and calls the render function only for
	 * items it has not emitted yet — so a view-wide "expanded" flag reaches rows
	 * that have not arrived and no row that has. That is what the key this
	 * replaced actually did, and why it was worse than useless: it expanded
	 * output you had not seen and could not touch the output you were looking at.
	 * The only expansion available to a row already on screen is a NEW row, which
	 * is what `/expand` pushes and what this flag marks.
	 */
	readonly detailExpanded?: boolean
}

export interface TuiContext {
	readonly cwd: string
	readonly version: string
	/**
	 * Values-free launch-time config provenance for `/debug-config`.
	 *
	 * Optional for embedded callers and the many hand-built App fixtures. The
	 * standalone CLI always supplies it; the command says when an embed did not.
	 */
	readonly configDebug?: ConfigDebugSnapshot
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
	readonly rules?: readonly AuthorizationRule[]
	/**
	 * External tool servers from the operator's config, by the same reasoning as
	 * `rules`: a config file belongs to the user, not to a command, and a server
	 * they declared has to be there whichever way they started namzu.
	 */
	readonly mcpServers?: McpServersConfig
	/**
	 * Isolation config, by the same reasoning as the two above: it belongs
	 * to the user, not to a command, so it has to reach the session
	 * whichever way namzu was started.
	 */
	readonly sandbox?: SandboxConfig
	/** Opted-in terminal notification settings from the resolved CLI config. */
	readonly tui?: TuiConfig
	/**
	 * --verbose/--quiet/NAMZU_LOG_LEVEL and --log-format/NAMZU_LOG_FORMAT,
	 * resolved once in `cli.ts` before the TUI launches. Optional for the
	 * same reason as `CommandContext.logging`: the many `<App ctx={...}>`
	 * fixtures under `tui/__tests__/` never touch logging and should not
	 * have to grow a field to keep compiling.
	 */
	readonly logging?: ResolvedLogging
}
