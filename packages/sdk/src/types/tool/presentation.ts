import type { ToolResult } from './index.js'

/**
 * How a tool call should be shown, decided by the tool.
 *
 * Presentation lived in one host as four free functions switching on a
 * lowercased tool NAME: `name === 'write'` and `name === 'edit'` got a
 * diff, everything else got a truncated string. So a tool the host had
 * never heard of — an MCP server's, a plugin's, a second host's — could
 * not get a diff no matter what it did, and every new host started from
 * the raw arguments and rebuilt the same switch.
 *
 * The tool knows what it is doing; the host knows how its surface renders.
 * These are the shapes hosts have agreed to render, closed
 * deliberately: an open union would let a tool ask for a rendering no host
 * has, which is a request that fails silently at the far end.
 */
export type ToolCallView =
	/** A line of text. What everything that is not a diff or a command gets. */
	| {
			readonly kind: 'generic'
			readonly label: string
			/** Render this complete authored label without adding the registry name. */
			readonly presentation?: 'activity'
			/** A successful result may add no information beyond the completed call row. */
			readonly visibility?: 'hidden'
	  }
	/**
	 * A change to a document. `path` is optional because not every diff is
	 * a file — a tool patching a remote record has a before and an after
	 * and no path a host could open.
	 */
	| {
			readonly kind: 'diff'
			readonly path?: string
			readonly before: string
			readonly after: string
	  }
	/** A command and what it printed. */
	| { readonly kind: 'terminal'; readonly command?: string; readonly output: string }

/** The same shapes, for what a call produced. */
export type ToolResultView = ToolCallView

/**
 * Optional presentation hooks on a tool definition.
 *
 * Both may return `undefined`, which means "no opinion" and is different
 * from returning a generic view: the first defers to the host's fallback,
 * the second asserts that a plain label is the right rendering.
 */
export interface ToolPresentation<TInput = unknown> {
	presentCall?(input: TInput): ToolCallView | undefined
	presentResult?(input: TInput, result: ToolResult): ToolResultView | undefined
}
