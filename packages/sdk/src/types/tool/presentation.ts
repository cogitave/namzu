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
			/** Successful observations may be grouped by hosts without discarding output. */
			readonly activity?: 'exploration'
			/** A successful result may add no information beyond the completed call row. */
			readonly visibility?: 'hidden'
			/**
			 * For a result: the person declined on the tool's own screen (a
			 * confirmation they cancelled). The call did not succeed, but
			 * nothing failed either, so a host draws it as neither: `label` says
			 * what did not happen ("Cancelled — nothing was saved").
			 */
			readonly outcome?: 'cancelled'
			/**
			 * For a result: a person answered No to this call at review, so it
			 * never ran. `label` names what it was about (the file, the command)
			 * and `note` is what the person said, in their own words and capped
			 * at 4,000 characters. Set only from the review answer, never read
			 * out of text; a refusal by policy does not carry it.
			 */
			readonly declined?: { readonly note?: string }
			/**
			 * For a call: what the call is about, as fields. A host headlines the
			 * row ("Read a.ts", "Searched for export") from these and never from
			 * the text of `label`.
			 */
			readonly facts?: ToolFacts
	  }
	/**
	 * A change to a document. `path` is optional because not every diff is
	 * a file — a tool patching a remote record has a before and an after
	 * and no path a host could open.
	 */
	| {
			readonly kind: 'diff'
			/** Optional operation summary, distinct from the file path. */
			readonly label?: string
			readonly path?: string
			readonly before: string
			readonly after: string
	  }
	/** A command and what it printed. */
	| { readonly kind: 'terminal'; readonly command?: string; readonly output: string }

/**
 * A bounded window onto a block of text: the first lines, the last lines, and
 * how much lay between. Small enough to travel in an event, and enough for a
 * host to show "head, tail, Show more" without holding the whole output.
 */
export interface ToolTextWindow {
	/** The first lines, or the whole text when it fit. */
	readonly head: string
	/** The last lines, present only when lines were left out between `head` and it. */
	readonly tail?: string
	/** Lines left out between `head` and `tail`. */
	readonly omittedLines?: number
	/** Lines in the whole text. */
	readonly totalLines: number
	/** Bytes in the whole text. */
	readonly totalBytes: number
}

/**
 * One hunk of a line diff: the changed lines with up to three unchanged lines
 * around them. Every row of `lines` is a space, `+` or `-` followed by the
 * line's text, without its newline. Line numbers start at 1.
 */
export interface ToolDiffHunk {
	readonly oldStart: number
	readonly oldLines: number
	readonly newStart: number
	readonly newLines: number
	readonly lines: readonly string[]
}

/** Why a call did not do what it was asked, as a kind a host can phrase for a person. */
export type ToolFailureReason =
	| 'not_found'
	| 'permission_denied'
	| 'not_a_file'
	| 'already_exists'
	| 'blocked'
	| 'needs_administrator'
	| 'unknown_tool'
	| 'timed_out'
	| 'invalid_input'
	/** An edit or write on a file the conversation never read. */
	| 'not_read'
	/** An edit or write based on a copy that has since changed on disk. */
	| 'changed_on_disk'
	/** An edit whose text is not in the file. */
	| 'text_not_found'
	/** An edit whose text appears more than once. */
	| 'not_unique'
	/** The call's arguments did not fit the tool's input schema, so the tool never ran. */
	| 'invalid_arguments'

/**
 * What a call was about and what came of it, as typed fields.
 *
 * `output` is written for the model and its wording is the model's interface.
 * A person is shown a different thing, and reading their screen out of the
 * model's prose is how "STDOUT:" and "1 replacement(s)" reached it. These are
 * the same facts the tool already knew, stated once, so a host never has to
 * read text to learn an exit code, a file name or whether a file was created.
 *
 * Every field but `kind` is optional: the same shape describes a call that is
 * still running (what it was asked) and one that finished (what it did).
 * Paths are as the tool resolved them; a host shortens them for display.
 */
export type ToolFacts =
	| {
			readonly kind: 'command'
			/** The command line, on the call. */
			readonly command?: string
			readonly exitCode?: number
			/**
			 * A non-zero `exitCode` that is the command's answer and not a failure
			 * (`grep` found nothing, `diff` found a difference): a short plain
			 * sentence. A host draws the call as having succeeded.
			 */
			readonly exitNote?: string
			readonly timedOut?: boolean
			/** The signal that ended it, when one did. */
			readonly signal?: string
			readonly stdout?: ToolTextWindow
			readonly stderr?: ToolTextWindow
			/** The output was not text; nothing of it is in `stdout`/`stderr`. */
			readonly binary?: { readonly bytes: number }
			/** The command was handed to a background job instead of being waited on. */
			readonly background?: true
	  }
	| {
			readonly kind: 'read'
			readonly path: string
			/** The file is not text; the person is told so instead of being shown its bytes. */
			readonly binary?: boolean
			readonly bytes?: number
			readonly totalLines?: number
			readonly returnedLines?: number
			/** Only a window of the file was returned. */
			readonly partial?: boolean
			/** The lines were not repeated: an earlier read of the same lines still holds. */
			readonly unchanged?: boolean
	  }
	| {
			readonly kind: 'search'
			readonly pattern: string
			readonly path?: string
			readonly matches?: number
			readonly filesMatched?: number
			readonly filesSearched?: number
			readonly truncated?: boolean
	  }
	| {
			readonly kind: 'list'
			readonly pattern: string
			readonly path?: string
			readonly count?: number
			readonly truncated?: boolean
	  }
	| {
			readonly kind: 'edit'
			readonly path?: string
			readonly replacements?: number
			/** Lines added and removed, counted from a real line diff of the whole file. */
			readonly added?: number
			readonly removed?: number
			/** The change as hunks with three lines of context. Capped; see `hunksTruncated`. */
			readonly hunks?: readonly ToolDiffHunk[]
			/** Some rows of the change are not in `hunks`; `added` and `removed` still cover all of it. */
			readonly hunksTruncated?: true
	  }
	| {
			readonly kind: 'write'
			readonly path: string
			/** `wrote` when the file's earlier state could not be established. */
			readonly operation: 'created' | 'updated' | 'unchanged' | 'wrote'
			readonly bytes?: number
			readonly added?: number
			readonly removed?: number
			/** The change as hunks; a created file is one hunk of added lines. Capped; see `hunksTruncated`. */
			readonly hunks?: readonly ToolDiffHunk[]
			readonly hunksTruncated?: true
	  }
	| {
			readonly kind: 'failure'
			readonly reason: ToolFailureReason
			/** What it was about: a path, or the tool's name for `unknown_tool`. */
			readonly subject?: string
	  }

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
