import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Model-visible size cap for a single tool result.
 *
 * ~40k characters is roughly 10k tokens: large enough that ordinary reads,
 * greps and command output pass through untouched, small enough that one
 * oversized result cannot consume a fifth of a 200k window.
 *
 * Nothing capped tool output before this. `read` returned a whole file when
 * `limit` was omitted, `bash` allowed a 100 MB buffer, and the MCP adapter
 * joined every text block uncapped — so a 2 MB lockfile became ~500k tokens
 * in a single `tool_result` and the run died on a provider error with
 * everything lost.
 */
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 40_000

/**
 * Share of the budget spent on the head. The rest goes to the tail.
 *
 * Weighted toward the head because that is where a document's structure
 * lives, but never all of it: the tail is where a command's error message
 * is, and a preview that drops it is useless for the most common reason a
 * result is being read at all.
 */
const HEAD_SHARE = 0.75

export interface ToolOutputBudgetResult {
	/** What the model sees. */
	readonly output: string
	/** Size before any reduction, for telemetry. */
	readonly originalLength: number
	readonly truncated: boolean
	/** Where the full output was written, when it was. */
	readonly spillPath?: string
}

export interface ApplyToolOutputBudgetOptions {
	readonly toolName: string
	readonly toolUseId: string
	readonly output: string
	readonly maxChars: number
	/**
	 * Directory to spill overflow into. When absent the output is
	 * middle-elided instead — degraded, but never unbounded.
	 */
	readonly spillDir?: string | undefined
	readonly onError?: (message: string) => void
}

/**
 * Bound a tool result to the model-visible budget.
 *
 * Spilling beats truncating on every axis that matters: nothing is lost,
 * tokens are paid only if the agent decides the rest is worth re-reading,
 * and retrieval uses `read`/`grep` — tools it already has — rather than a
 * new affordance. A hosted agent runtime does the same thing above 100k
 * characters. Middle-elision is the fallback for a run with no directory
 * to write to.
 *
 * The preview keeps head AND tail because the two ends carry different
 * information: the head has the schema/opening of a document, the tail has
 * the error a command died on.
 */
export function applyToolOutputBudget(opts: ApplyToolOutputBudgetOptions): ToolOutputBudgetResult {
	const { output, maxChars } = opts
	const originalLength = output.length

	if (!Number.isFinite(maxChars) || maxChars <= 0 || originalLength <= maxChars) {
		return { output, originalLength, truncated: false }
	}

	// Both slices are derived from `maxChars` so the preview honours the
	// budget it is enforcing. `slice(-0)` returns the WHOLE string, so the
	// zero-tail case must be branched, not computed.
	const headChars = Math.max(1, Math.floor(maxChars * HEAD_SHARE))
	const tailChars = Math.max(0, maxChars - headChars)
	const head = output.slice(0, headChars)
	const tail = tailChars > 0 ? output.slice(-tailChars) : ''
	const omitted = originalLength - head.length - tail.length

	const spillPath = opts.spillDir
		? spill(opts.spillDir, opts.toolUseId, output, opts.onError)
		: undefined

	const recovery = spillPath
		? [
				`The full output was written to: ${spillPath}`,
				'Read a specific window with `read` (offset/limit) or search it with `grep`. Do NOT read it whole — that is what exceeded the budget.',
			].join('\n')
		: 'The full output was not retained. Re-run with a narrower query, a line range, or a filter.'

	return {
		output: [
			head,
			'',
			`[... ${omitted.toLocaleString()} characters omitted — "${opts.toolName}" returned ${originalLength.toLocaleString()} characters, over the ${maxChars.toLocaleString()}-character budget ...]`,
			recovery,
			'',
			tail,
		].join('\n'),
		originalLength,
		truncated: true,
		...(spillPath ? { spillPath } : {}),
	}
}

function spill(
	dir: string,
	toolUseId: string,
	content: string,
	onError?: (message: string) => void,
): string | undefined {
	try {
		mkdirSync(dir, { recursive: true })
		// The tool_use id is already unique per call and safe as a filename.
		const path = join(dir, `${toolUseId}.txt`)
		writeFileSync(path, content, 'utf-8')
		return path
	} catch (err) {
		// A spill failure must never fail the tool call — the model still
		// gets the preview, just without a path to recover the rest.
		onError?.(err instanceof Error ? err.message : String(err))
		return undefined
	}
}
