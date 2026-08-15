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
 * Opening of the line that points at a spilled output.
 *
 * A constant rather than a phrase repeated in two files, because the line
 * has to survive later editing: compaction clears stale tool results, and
 * clearing a spilled one destroys the only route back to the content this
 * budget deliberately kept. Whatever clears a result has to be able to
 * recognise this line and keep it.
 */
export const SPILL_MARKER = 'The full output was written to:'

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

/**
 * Name what a truncated result took with it.
 *
 * Returns `undefined` when there was nothing but text to lose, so the
 * ordinary case adds no noise.
 *
 * The model is the reader here, and it is reasoning about a result it can
 * no longer fully see. "An image was returned and is not shown" is a fact
 * it can act on — ask for a smaller region, re-run against a file — where
 * silence looks exactly like a tool that only ever returns text.
 */
export function describeDroppedContent(
	content: readonly { type?: string }[] | unknown,
): string | undefined {
	if (!Array.isArray(content)) return undefined

	const counts = new Map<string, number>()
	for (const block of content as readonly { type?: unknown }[]) {
		const kind = typeof block?.type === 'string' ? block.type : 'content'
		if (kind === 'text') continue
		counts.set(kind, (counts.get(kind) ?? 0) + 1)
	}
	if (counts.size === 0) return undefined

	const parts = [...counts].map(([kind, n]) => (n === 1 ? `1 ${kind}` : `${n} ${kind} blocks`))
	return `[${parts.join(', ')} omitted: this result was truncated, and the preview above no longer describes them.]`
}

/**
 * Total size of the rich channel, in base64 characters.
 *
 * Measured on the payload rather than the block count, because one block
 * is the whole cost: a single screenshot is the largest thing a tool
 * result can carry.
 */
export function measureContentBytes(content: readonly unknown[] | unknown): number {
	if (!Array.isArray(content)) return 0
	let total = 0
	for (const block of content as readonly Record<string, unknown>[]) {
		if (typeof block?.data === 'string') total += block.data.length
		else if (typeof block?.text === 'string') total += block.text.length
	}
	return total
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
				`${SPILL_MARKER} ${spillPath}`,
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
		// `0o700` on the directory and `0o600` on the file: a spilled output is
		// routinely the largest and most sensitive thing a run produces — whole
		// files, whole command outputs — and the default `0o755`/`0o644` made
		// every one of them world-readable on a shared host.
		//
		// The mode is applied to directories this call CREATES. A spill
		// directory the host made itself keeps whatever mode the host chose,
		// which is the host's decision to make and not this function's to
		// override.
		mkdirSync(dir, { recursive: true, mode: 0o700 })
		// The tool_use id is already unique per call and safe as a filename.
		const path = join(dir, `${toolUseId}.txt`)
		// `wx`, not the default `w`. `w` creates-or-truncates and FOLLOWS a
		// symlink, at a path anything that can write to this directory could
		// predict and pre-plant — so the kernel would overwrite the symlink's
		// target with content the model chose. `wx` fails with EEXIST instead,
		// and never follows.
		//
		// The property being bought is exclusivity of the open, not
		// unpredictability of the name: `toolUseId` is already unique per call,
		// so randomising the filename would add nothing this does not already
		// have. Do not "improve" it back to a random name and a plain `w` —
		// that trades a guarantee for a guess.
		writeFileSync(path, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
		return path
	} catch (err) {
		// A spill failure must never fail the tool call — the model still
		// gets the preview, just without a path to recover the rest.
		//
		// EEXIST is reported as its own sentence rather than folded into the
		// generic message, because the two causes lead to opposite next moves:
		// a stale file from a reused output directory is housekeeping, while
		// something arriving at a path only this run should know is the case
		// the exclusive open exists to refuse, and an operator has to be able
		// to tell them apart from the log line alone.
		const code = (err as NodeJS.ErrnoException | undefined)?.code
		const detail = err instanceof Error ? err.message : String(err)
		onError?.(
			code === 'EEXIST'
				? `Refused to overwrite an existing file at the spill path; the output was not retained. ${detail}`
				: detail,
		)
		return undefined
	}
}
