import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { digest, spillManifest } from '../../store/evidence/format.js'

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
 * in a single `tool_result` and the turn died on a provider error with
 * everything lost.
 */
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 40_000

/**
 * Cap on the COMBINED model-visible text of every tool result one assistant
 * message produced.
 *
 * The per-result cap alone lets eight parallel calls put 320,000 characters in
 * front of the model at once. This is the bound on the whole batch; see
 * {@link fitResultsToMessageBudget}.
 */
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS_PER_MESSAGE = 200_000

/** Size of the preview that stands in for a result replaced to fit the message budget. */
export const MESSAGE_BUDGET_PREVIEW_CHARS = 2_000

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

function safeHead(text: string, maxChars: number): string {
	let end = Math.min(text.length, Math.max(0, maxChars))
	if (end > 0) {
		const last = text.charCodeAt(end - 1)
		if (last >= 0xd800 && last <= 0xdbff) end--
	}
	return text.slice(0, end)
}

function safeTail(text: string, maxChars: number): string {
	let start = Math.max(0, text.length - Math.max(0, maxChars))
	if (start < text.length) {
		const first = text.charCodeAt(start)
		if (first >= 0xdc00 && first <= 0xdfff) start++
	}
	return text.slice(start)
}

/**
 * Fit a recoverable head+tail preview inside the actual model-visible cap.
 *
 * The old implementation allocated the entire cap to source text and then
 * appended its diagnostic and recovery instructions. A configured 1,000
 * character cap therefore emitted 1,200–1,300 characters; at very small
 * limits the explanation could be several times larger than the limit.
 */
function boundedPreview(
	output: string,
	maxChars: number,
	toolName: string,
	recovery: string,
): string {
	const detailedMiddle = [
		'',
		`[... characters omitted — "${toolName}" returned ${output.length.toLocaleString()} characters, over the ${maxChars.toLocaleString()}-character budget ...]`,
		recovery,
		'',
	].join('\n')
	const compactMiddle = '\n[... omitted ...]\n'
	const spillLine = recovery.split('\n').find((line) => line.startsWith(SPILL_MARKER))
	const compactRecovery = spillLine ? `${compactMiddle}${spillLine}\n` : compactMiddle
	const middle =
		detailedMiddle.length < maxChars
			? detailedMiddle
			: compactRecovery.length < maxChars
				? compactRecovery
				: compactMiddle

	// A host may deliberately set a tiny positive cap. At that point no
	// truthful recovery sentence fits; the hard bound still wins.
	if (middle.length >= maxChars) return safeHead(middle, maxChars)

	const sourceChars = maxChars - middle.length
	const headChars = Math.max(1, Math.floor(sourceChars * HEAD_SHARE))
	const tailChars = Math.max(0, sourceChars - headChars)
	return `${safeHead(output, headChars)}${middle}${safeTail(output, tailChars)}`
}

export interface ToolOutputBudgetResult {
	/** What the model sees. */
	readonly output: string
	/** Size before any reduction, for telemetry. */
	readonly originalLength: number
	readonly truncated: boolean
	/** Where the full output was written, when it was. */
	readonly spillPath?: string
	/** Digest of the bounded chunk manifest, recorded at retention time. */
	readonly spillIntegrity?: string
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
	return `[${parts.join(', ')} omitted from this model request.]`
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
		if (block?.type !== 'text' && typeof block?.data === 'string') total += block.data.length
	}
	return total
}

export interface ApplyToolOutputBudgetOptions {
	readonly toolName: string
	readonly toolUseId: string
	readonly output: string
	readonly maxChars: number
	/** Optional condensed presentation; used only after authenticated retention of output. */
	readonly preview?: string
	/** Smaller preview only after the full output and its integrity manifest are saved. */
	readonly retainedPreviewChars?: number
	/** An omission notice that shares the text budget, never extends it. */
	readonly notice?: string
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
 * Retention keeps the original while bounding its model-visible preview.
 * The host owns the recovery route and its permissions; a spill path is not
 * proof that workspace read/grep tools can access it. Middle-elision is the
 * fallback for a turn with no directory to write to.
 *
 * The preview keeps head AND tail because the two ends carry different
 * information: the head has the schema/opening of a document, the tail has
 * the error a command died on.
 */
export function applyToolOutputBudget(opts: ApplyToolOutputBudgetOptions): ToolOutputBudgetResult {
	const { output, maxChars } = opts
	const originalLength = output.length
	const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : undefined
	const notice = opts.notice
		? limit === undefined
			? opts.notice
			: safeHead(opts.notice, limit)
		: ''
	const textBudget =
		limit === undefined
			? undefined
			: Math.max(0, limit - notice.length - (notice && output ? 2 : 0))
	const withNotice = (text: string) => [text, notice].filter(Boolean).join('\n\n')

	const preview =
		opts.preview !== undefined && opts.preview.length < originalLength ? opts.preview : undefined
	if (preview === undefined && (textBudget === undefined || originalLength <= textBudget)) {
		return { output: withNotice(output), originalLength, truncated: false }
	}

	const retained = opts.spillDir
		? spill(opts.spillDir, opts.toolUseId, output, opts.onError)
		: undefined

	const spillPath = retained?.path
	const recovery = spillPath
		? [
				`${SPILL_MARKER} ${spillPath}`,
				'This path identifies retained output, not the original input. Use the host-authorized retained-output recovery tools when available; the path does not grant filesystem access. A fresh observation of the original input cannot recover its earlier contents. If recovery is unavailable, report the missing detail; do not replay the original action.',
			].join('\n')
		: 'The full output was not retained. Use a saved artifact or a read-only observation; do not repeat a state-changing action to recover its output.'
	const requestedPreview = opts.retainedPreviewChars
	// Separate the spill threshold from the cost of carrying its preview on every
	// later request. Failed retention must not silently discard additional text.
	// A small configured preview still needs room for the durable recovery path.
	const previewLimit =
		retained?.integrity &&
		requestedPreview !== undefined &&
		Number.isFinite(requestedPreview) &&
		requestedPreview > 0
			? Math.min(limit as number, Math.floor(requestedPreview))
			: (limit as number)
	const previewTextBudget = Math.max(0, previewLimit - notice.length - (notice && output ? 2 : 0))
	const minimumRecoveryChars = `\n[... omitted ...]\n${SPILL_MARKER} ${spillPath}\n`.length
	const effectiveTextBudget =
		previewTextBudget > minimumRecoveryChars ? previewTextBudget : textBudget
	// Condensation is a display choice, not permission to discard evidence. The
	// original can be under the ordinary cap while still losing distinct rows.
	// Failed retention falls back to the original, bounded by the usual cap.
	if (preview !== undefined && retained?.integrity) {
		const condensed = [preview, recovery].filter(Boolean).join('\n\n')
		if (effectiveTextBudget === undefined || condensed.length <= effectiveTextBudget) {
			return {
				output: withNotice(condensed),
				originalLength,
				truncated: true,
				spillPath,
				spillIntegrity: retained.integrity,
			}
		}
	}
	if (textBudget === undefined || originalLength <= textBudget) {
		return { output: withNotice(output), originalLength, truncated: false }
	}

	return {
		output: withNotice(
			boundedPreview(output, effectiveTextBudget ?? textBudget, opts.toolName, recovery),
		),
		originalLength,
		truncated: true,
		...(spillPath ? { spillPath } : {}),
		...(retained?.integrity ? { spillIntegrity: retained.integrity } : {}),
	}
}

function spill(
	dir: string,
	toolUseId: string,
	content: string,
	onError?: (message: string) => void,
): { path: string; integrity?: string } | undefined {
	try {
		// `0o700` on the directory and `0o600` on the file: a spilled output is
		// routinely the largest and most sensitive thing a turn produces — whole
		// files, whole command outputs — and the default `0o755`/`0o644` made
		// every one of them world-readable on a shared host.
		//
		// The mode is applied to directories this call CREATES. A spill
		// directory the host made itself keeps whatever mode the host chose,
		// which is the host's decision to make and not this function's to
		// override.
		mkdirSync(dir, { recursive: true, mode: 0o700 })
		// Provider correlation IDs are opaque strings, not filesystem names.
		// A digest preserves deterministic lookup without interpreting slashes,
		// traversal segments or platform-specific path syntax from the provider.
		const name = createHash('sha256').update(toolUseId).digest('hex')
		const path = join(dir, `${name}.txt`)
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
		const bytes = Buffer.from(content, 'utf8')
		writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
		try {
			const manifest = spillManifest(bytes)
			writeFileSync(`${path}.manifest.json`, manifest, {
				flag: 'wx',
				mode: 0o600,
			})
			return { path, integrity: digest(manifest) }
		} catch {
			onError?.('The full output was retained, but its integrity manifest could not be written.')
			return { path }
		}
	} catch (err) {
		// A spill failure must never fail the tool call — the model still
		// gets the preview, just without a path to recover the rest.
		//
		// EEXIST is reported as its own sentence rather than folded into the
		// generic message, because the two causes lead to opposite next moves:
		// a stale file from a reused output directory is housekeeping, while
		// something arriving at a path only this turn should know is the case
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

export interface MessageBudgetItem {
	readonly toolCallId: string
	readonly toolName: string
	readonly output: string
	/** False for a result that must stay as the tool produced it. */
	readonly replaceable: boolean
}

export interface MessageBudgetReplacement {
	readonly output: string
	readonly originalLength: number
	readonly spillPath?: string
}

export interface FitResultsToMessageBudgetOptions {
	readonly maxChars: number
	readonly spillDir?: string | undefined
	readonly onError?: (message: string) => void
}

const SPILL_LINE = new RegExp(`^${SPILL_MARKER} .+$`, 'm')

/**
 * Hold one assistant message's combined tool results under a cap.
 *
 * Replaceable results are replaced largest first, each by a short preview that
 * names where its full text is kept, until the total is within `maxChars`. A
 * result already spilled keeps the path it was given; one that was not is
 * spilled now. Results that are not replaceable are left alone and are not
 * counted, because nothing here could reduce them.
 *
 * The caller writes the replacement into the result BEFORE the result reaches
 * the history. From then on it is just the message's content, so it is the
 * same on every later request and a prompt-cache prefix over it stays valid;
 * nothing is decided again on a later turn.
 *
 * Returns only the results that changed, keyed by `toolCallId`. Ties keep the
 * earlier call, so the same batch always yields the same replacements.
 */
export function fitResultsToMessageBudget(
	items: readonly MessageBudgetItem[],
	opts: FitResultsToMessageBudgetOptions,
): Map<string, MessageBudgetReplacement> {
	const replaced = new Map<string, MessageBudgetReplacement>()
	if (!Number.isFinite(opts.maxChars) || opts.maxChars <= 0) return replaced

	const candidates = items.filter((item) => item.replaceable)
	let total = candidates.reduce((sum, item) => sum + item.output.length, 0)
	if (total <= opts.maxChars) return replaced

	const bySize = candidates
		.map((item, index) => ({ item, index }))
		.sort((a, b) => b.item.output.length - a.item.output.length || a.index - b.index)

	for (const { item } of bySize) {
		if (total <= opts.maxChars) break
		const replacement = previewForMessageBudget(item, opts)
		if (replacement.output.length >= item.output.length) continue
		total -= item.output.length - replacement.output.length
		replaced.set(item.toolCallId, replacement)
	}
	return replaced
}

function previewForMessageBudget(
	item: MessageBudgetItem,
	opts: FitResultsToMessageBudgetOptions,
): MessageBudgetReplacement {
	const spilledAt = SPILL_LINE.exec(item.output)?.[0]
	if (spilledAt !== undefined) {
		const output = [
			safeHead(item.output, MESSAGE_BUDGET_PREVIEW_CHARS / 2),
			'',
			`[... omitted: this message's tool results together were over the ${opts.maxChars.toLocaleString()}-character budget ...]`,
			spilledAt,
		].join('\n')
		return {
			output,
			originalLength: item.output.length,
			spillPath: spilledAt.slice(SPILL_MARKER.length + 1),
		}
	}
	const budgeted = applyToolOutputBudget({
		toolName: item.toolName,
		// A distinct name: the spill file is keyed by it and opened exclusively.
		toolUseId: `${item.toolCallId}:message-budget`,
		output: item.output,
		maxChars: MESSAGE_BUDGET_PREVIEW_CHARS,
		spillDir: opts.spillDir,
		...(opts.onError ? { onError: opts.onError } : {}),
	})
	return {
		output: budgeted.output,
		originalLength: item.output.length,
		...(budgeted.spillPath ? { spillPath: budgeted.spillPath } : {}),
	}
}
