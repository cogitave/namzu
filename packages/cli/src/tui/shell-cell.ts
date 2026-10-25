/**
 * The shell command cell: how a finished (or running) shell call reads in the
 * transcript.
 *
 *     ● Bash(npm test)
 *       ⎿  first output line
 *          second output line
 *          third output line
 *          … +12 lines (ctrl+o to expand)
 *
 * Pure functions only. The row component in `Transcript.tsx` draws what these
 * return; `App.tsx` builds the {@link ShellOutput} from the call's typed facts.
 *
 * Rules, in one place so the live row, the settled row, the height estimate and
 * the tests cannot disagree:
 *
 * - The header keeps the command's real line breaks, up to 2 lines and 160
 *   characters, then `…`. The whole command is shown when the row is expanded.
 * - stdout comes first, then stderr in the error colour. Each stream shows its
 *   first 3 visual lines (10 when the command failed), then a dim
 *   `… +N lines (ctrl+o to expand)`. When exactly one line would be hidden it
 *   is shown instead, because the hint row would take the same space.
 * - No output at all is a dim note: `(No output)`, `Exit code N`, or
 *   `Running in the background (↓ to manage)`.
 */

import stringWidth from 'string-width'
import { hiddenLinesHint } from './truncation.js'

import { theme } from './theme.js'
import { NOT_SHOWN_LINE } from './tidy-tool-output.js'

export const SHELL_HEADER_LINES = 2
export const SHELL_HEADER_CHARS = 160
/** Visual lines a stream shows before eliding, on success. */
export const SHELL_PREVIEW_LINES = 3
/** Visual lines a stream shows before eliding, when the command failed. */
export const SHELL_FAILURE_LINES = 10
/** Lines of a running command's output shown live. */
export const SHELL_LIVE_LINES = 5

/** What a shell call printed, as the transcript keeps it. */
export interface ShellOutput {
	readonly stdout: readonly string[]
	readonly stderr: readonly string[]
	/** The command failed: stderr and the exit status get the longer preview. */
	readonly failed: boolean
	/** Said when there is nothing else to say (`(No output)`, `Exit code 3`, ...). */
	readonly note?: string
	/** A short status line for a failed command that also printed output, e.g. `Exit code 3`. */
	readonly status?: string
	/** The complete header, when {@link shellCommandHeader} cut it. */
	readonly fullHeader?: string
	/**
	 * Count lines as the text has them: a long line is not several, and a single
	 * folded line still says so. For an error message drawn as the tool wrote it.
	 */
	readonly byLine?: true
	/** Shown in place of `stderr` until the body is expanded. */
	readonly folded?: readonly string[]
}

export type ShellTone = 'out' | 'err' | 'dim'

export interface ShellRow {
	readonly text: string
	readonly tone: ShellTone
}

function cutSurrogate(text: string): string {
	return text.replace(/[\uD800-\uDBFF]$/, '')
}

/**
 * The command as the header shows it: real line breaks kept, at most 2 lines
 * and 160 characters, a single `…` when something was cut.
 */
export function shellCommandHeader(command: string): string {
	const lines = command.replace(/\r\n/g, '\n').trim().split('\n')
	let text = lines.slice(0, SHELL_HEADER_LINES).join('\n')
	let cut = lines.length > SHELL_HEADER_LINES
	if (text.length > SHELL_HEADER_CHARS) {
		text = cutSurrogate(text.slice(0, SHELL_HEADER_CHARS))
		cut = true
	}
	return cut ? `${text.trimEnd()}…` : text
}

/** The command with its line breaks and no cut, for the expanded view. */
export function shellCommandFull(command: string): string {
	return command.replace(/\r\n/g, '\n').trim()
}

/**
 * Break one logical line into rows of at most `width` terminal cells. Spaces
 * are kept: command output is often indented, and the reader aligns on it.
 */
export function wrapShellLine(line: string, width: number): string[] {
	const limit = Math.max(1, width)
	if (line.length <= limit && stringWidth(line) <= limit) return [line]
	const rows: string[] = []
	let row = ''
	let used = 0
	for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
		line,
	)) {
		const cells = stringWidth(segment)
		if (used + cells > limit && row.length > 0) {
			rows.push(row)
			row = ''
			used = 0
		}
		row += segment
		used += cells
	}
	rows.push(row)
	return rows
}

function visualLines(lines: readonly string[], width: number | undefined): string[] {
	if (width === undefined) return [...lines]
	return lines.flatMap((line) => wrapShellLine(line, width))
}

export interface ShellRowOptions {
	/** Show everything: no preview limit, no hint. */
	readonly expanded: boolean
	/** Cells available for one output row; unset counts each line as one row. */
	readonly width?: number
	/** The `(ctrl+o to expand)` suffix is true: the row can be expanded. */
	readonly canExpand?: boolean
	/** Lines are counted as the text has them; see {@link ShellOutput.byLine}. */
	readonly byLine?: boolean
}

/** How many output lines a row stands for: a kernel gap line stands for all it left out. */
function weight(text: string): number {
	const gap = NOT_SHOWN_LINE.exec(text)
	return gap ? Number((gap[1] ?? '1').replaceAll(',', '')) : 1
}

function stream(
	lines: readonly string[],
	tone: 'out' | 'err',
	limit: number,
	options: ShellRowOptions,
): ShellRow[] {
	const rows = visualLines(lines, options.width).map((text) => ({ text, tone }) as const)
	if (options.expanded || rows.length <= limit) return rows
	const hidden = rows.slice(limit).reduce((count, row) => count + weight(row.text), 0)
	// One hidden line costs a row to say so, so it is simply shown.
	if (hidden === 1 && !options.byLine) return rows
	return [
		...rows.slice(0, limit),
		{
			text: hiddenLinesHint(hidden, {
				...(options.byLine
					? {}
					: { chars: rows.slice(limit).reduce((sum, row) => sum + row.text.length, 0) }),
				canExpand: options.canExpand !== false,
			}),
			tone: 'dim',
		},
	]
}

/** The rows under a settled shell call's header. */
export function shellResultRows(shell: ShellOutput, options: ShellRowOptions): ShellRow[] {
	const limit = shell.failed ? SHELL_FAILURE_LINES : SHELL_PREVIEW_LINES
	const byLine = shell.byLine === true
	const shown: ShellRowOptions = byLine ? { ...options, byLine } : options
	const rows = [
		...stream(shell.stdout, 'out', limit, shown),
		...stream(!options.expanded && shell.folded ? shell.folded : shell.stderr, 'err', limit, shown),
	]
	if (rows.length === 0) {
		return [{ text: shell.note ?? '(No output)', tone: shell.failed ? 'err' : 'dim' }]
	}
	return shell.status ? [{ text: shell.status, tone: 'err' }, ...rows] : rows
}

/**
 * Whether the settled row hides anything at some width, so a body numbered for
 * Ctrl+O exists. Wrapping is unknown here, so a long line counts as possibly
 * wrapped: a false yes only numbers a body that has nothing more to show.
 */
export function shellCollapses(shell: ShellOutput | undefined): boolean {
	if (!shell) return false
	if (shell.fullHeader !== undefined) return true
	const limit = shell.failed ? SHELL_FAILURE_LINES : SHELL_PREVIEW_LINES
	if (shell.folded) return true
	return [shell.stdout, shell.stderr].some(
		(lines) =>
			lines.length > limit || (!shell.byLine && lines.some((line) => stringWidth(line) > 60)),
	)
}

/** Every line of the row as plain text, for raw output and the height estimate. */
export function shellPlainLines(shell: ShellOutput): string[] {
	return shellResultRows(shell, { expanded: true }).map((row) => row.text)
}

/** The live rows under a running call's header. `tail` is the output seen so far. */
export function shellRunningRows(
	tail: readonly string[],
	elapsed: string,
	timeout?: string,
): ShellRow[] {
	const suffix = timeout ? `${elapsed} · timeout ${timeout}` : elapsed
	if (tail.length === 0) return [{ text: `Running… (${suffix})`, tone: 'dim' }]
	return [
		...tail.slice(-SHELL_LIVE_LINES).map((text) => ({ text, tone: 'dim' }) as const),
		{ text: `(${suffix})`, tone: 'dim' },
	]
}

/** Colour of one shell result row. */
export function shellToneColor(tone: ShellTone): string {
	switch (tone) {
		case 'err':
			return theme.status.error
		case 'dim':
			return theme.text.muted
		case 'out':
			return theme.text.secondary
	}
}
