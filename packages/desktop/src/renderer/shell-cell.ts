import type { StreamText } from './tool-transcript-presentation.js'

/**
 * What a finished shell command shows under its headline, as the terminal's shell cell does: the first
 * lines of what it printed, stderr in the error colour, how it ended once, and a plain note when there
 * is nothing else to say. Built from typed fields, never from the model's text.
 */
export interface ShellCellData {
	stdout?: StreamText
	stderr?: StreamText
	/** The command ended badly: its preview is longer. */
	failed: boolean
	/** How it ended, once: "Exit code 3", "Timed out", "Stopped before it finished". */
	status?: string
	/** The command was handed to a background job. */
	background?: true
	/** Output that is not text, in a sentence. */
	notice?: string
}

/** Lines of a stream shown before "+N lines"; a failed command shows more. */
export const SHELL_PREVIEW_LINES = 3
export const SHELL_FAILURE_LINES = 10

export interface ShellLine {
	text: string
	tone: 'out' | 'err' | 'gap'
}

export interface ShellCellRows {
	lines: ShellLine[]
	/** Output lines the preview leaves out; 0 when it shows everything. */
	hidden: number
	/** The words under the output: how it ended, "(No output)", or where it runs. */
	note?: string
	noteTone?: 'dim' | 'err'
}

function split(text: string | undefined): string[] {
	return text ? text.split('\n') : []
}

function streamLines(
	stream: StreamText | undefined,
	tone: 'out' | 'err',
	limit: number,
	expanded: boolean,
): { lines: ShellLine[]; hidden: number } {
	if (!stream) return { lines: [], hidden: 0 }
	const head = split(stream.head)
	const tail = split(stream.tail)
	if (expanded) {
		return {
			lines: [
				...head.map((text) => ({ text, tone })),
				...(stream.omitted > 0
					? [
							{
								text: `… ${stream.omitted.toLocaleString('en')} lines not shown`,
								tone: 'gap' as const,
							},
						]
					: []),
				...tail.map((text) => ({ text, tone })),
			],
			hidden: 0,
		}
	}
	const total = Math.max(stream.total, head.length + tail.length + stream.omitted)
	// One hidden line would cost a row to say so, so it is simply shown.
	const take = total - limit === 1 && head.length > limit ? limit + 1 : limit
	const shown = head.slice(0, take)
	return { lines: shown.map((text) => ({ text, tone })), hidden: Math.max(0, total - shown.length) }
}

export function shellCellRows(cell: ShellCellData, expanded: boolean): ShellCellRows {
	const limit = cell.failed ? SHELL_FAILURE_LINES : SHELL_PREVIEW_LINES
	const out = streamLines(cell.stdout, 'out', limit, expanded)
	const err = streamLines(cell.stderr, 'err', limit, expanded)
	const lines = [...out.lines, ...err.lines]
	const hidden = out.hidden + err.hidden
	if (cell.notice) return { lines: [], hidden: 0, note: cell.notice, noteTone: 'dim' }
	if (cell.background && lines.length === 0)
		return { lines, hidden, note: 'Running in the background', noteTone: 'dim' }
	if (cell.status) return { lines, hidden, note: cell.status, noteTone: 'err' }
	if (lines.length === 0) return { lines, hidden, note: '(No output)', noteTone: 'dim' }
	return { lines, hidden }
}
