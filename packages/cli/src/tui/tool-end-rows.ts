import { isBackgroundLaunch } from '../integrations/workflows/notice.js'
import { WORKFLOW_BACKGROUND_NOTE, WORKFLOW_TOOL_NAME } from '../integrations/workflows/offering.js'
import type { AgentEvent } from './agent.js'
import { connectorToolLabel, plainConnectorSummary } from './connector-label.js'
import { conversationEvidenceView } from './conversation-evidence-view.js'
import { type ProposedChange, proposedBody } from './diff-rows.js'
import { spansText } from './diff-view.js'
import { modelCatalogueView } from './model-catalogue-view.js'
import { type ShellOutput, shellCommandFull, shellCommandHeader } from './shell-cell.js'
import { isTaskTool } from './task-activity.js'
import { theme } from './theme.js'
import { declinedLine } from './tidy-tool-output.js'
import { firstLineOf, toolFailureText } from './tool-failure-text.js'
import { EXPAND_HINT } from './truncation.js'
import type { TranscriptMessage } from './types.js'
import { settledElapsed } from './units.js'
import { type WebActivity, webCallTitle, webSettledLine } from './web-activity.js'

/**
 * The rows a finished tool call leaves in the transcript.
 *
 * This is the one place those rows are decided. The live run calls it as each
 * call ends, and a resumed conversation calls it for every call it saved, so
 * a change to how a read, an edit, a command or a search is drawn reaches both
 * without a second edit.
 */

export type ToolEndEvent = Extract<AgentEvent, { kind: 'tool-end' }>

/** What the call's start said, kept until it ends. */
export interface ToolEndStart {
	readonly label: string
	readonly detail?: readonly string[]
	readonly command?: string
	readonly web?: WebActivity
	readonly activity?: 'exploration'
	/** What an edit or write asked for, drawn dimmed if the person refuses it. */
	readonly proposed?: ProposedChange
}

/** One row to add, in the order of `pushMessage`'s arguments that matter. */
export type ToolRow = Pick<TranscriptMessage, 'role' | 'content'> &
	Partial<
		Pick<
			TranscriptMessage,
			'glyph' | 'glyphColor' | 'meta' | 'detail' | 'activity' | 'shell' | 'diff'
		>
	>

export type ToolEndRows =
	/** Add these rows. */
	| { readonly kind: 'rows'; readonly rows: readonly ToolRow[] }
	/** The task checklist owns this result; the caller writes (or skips) its block. */
	| { readonly kind: 'task-block' }
	/** Nothing to add. */
	| { readonly kind: 'none' }

export interface ToolEndContext {
	/** How long the call took, when known; the default row shows it. */
	readonly elapsedMs?: number
	/** Whether the model's plan has items, so a task listing refreshes the block instead of a row. */
	readonly hasPlan: boolean
	/** The working folder, to find where a refused edit would have landed. */
	readonly cwd?: string
}

/** Tools headed under another name: an edit is an `Update`. */
const DISPLAY_NAMES: Readonly<Record<string, string>> = { edit: 'Update' }

/**
 * A call's label: the tool name title-cased, then its most identifying
 * argument, as `Bash(ls -la)` or `Read(file.ts)`. A bare tool name in a
 * transcript of forty calls says nothing about which one this was. An edit
 * reads `Update(file.ts)`.
 */
export function formatToolCall(toolName: string, summary: string, standalone = false): string {
	if (standalone) return summary
	// A connector's tool reads `slack · post(hello)`: its server and tool, then a few
	// words of what it was asked, never the wire name or the raw input.
	if (toolName.startsWith('mcp__')) {
		const label = connectorToolLabel(toolName)
		const plain = plainConnectorSummary(summary)
		return plain.length > 0 ? `${label}(${plain})` : label
	}
	const words = toolName.replace(/[_-]+/g, ' ')
	const display =
		DISPLAY_NAMES[toolName.toLowerCase()] ??
		(words.length > 0 ? words[0]?.toUpperCase() + words.slice(1) : words)
	return summary.length > 0 ? `${display}(${summary})` : display
}

/** A failure line without the interpreter's error name (`Error: `, `TypeError: `) in front of the sentence. */
export function withoutErrorName(text: string): string {
	return text.replace(/^(?:[A-Za-z]*Error:\s*)+/, '')
}

/** An error message drawn as the tool wrote it: error colour, ten lines, then the fold. */
function failureBody(lines: readonly string[], folded?: readonly string[]): ShellOutput {
	return { stdout: [], stderr: lines, failed: true, byLine: true, ...(folded ? { folded } : {}) }
}

/** The words a call is headed with when its start was never seen. */
function headOf(event: ToolEndEvent, start: ToolEndStart | undefined) {
	return start?.label ?? formatToolCall(event.toolName, event.summary)
}

/** Rows for a finished call, from the branches that need nothing but the call and its result. */
export function toolEndRows(
	event: ToolEndEvent,
	start: ToolEndStart | undefined,
	ctx: ToolEndContext,
): ToolEndRows {
	const rows = (list: readonly ToolRow[]): ToolEndRows => ({ kind: 'rows', rows: list })
	if (!event.isError && start?.activity === 'exploration') {
		// Preserve the result, including the summary removed from detail by the adapter.
		const output =
			event.output !== undefined
				? event.output.split('\n')
				: [...(event.summary ? [event.summary] : []), ...(event.detail ?? [])]
		return rows([
			{
				role: 'tool',
				content: event.headline ?? start.label,
				glyph: '⎿',
				detail: output,
				glyphColor: theme.text.muted,
				...(output.length > 0 ? { meta: EXPAND_HINT } : {}),
				activity: 'exploration',
			},
		])
	}
	const web = event.web ?? start?.web
	if (web) {
		// Two rows, the call and what it came to, drawn as `web` activity:
		// consecutive ones sit together and the result list stays behind
		// Ctrl+O.
		const activity: WebActivity = {
			...web,
			...((event.web?.target ?? start?.web?.target)
				? { target: event.web?.target ?? start?.web?.target }
				: {}),
		}
		const durationMs = event.durationMs ?? ctx.elapsedMs
		const output = web.hosted ? undefined : event.output
		const outputLines = output !== undefined ? output.split('\n') : undefined
		return rows([
			{
				role: 'tool',
				content: webCallTitle(activity),
				glyph: '●',
				glyphColor: event.isError ? theme.status.error : theme.status.ok,
				activity: 'web',
			},
			{
				role: 'tool',
				content: event.isError
					? `failed: ${event.summary}`
					: webSettledLine(activity, {
							...(durationMs !== undefined ? { durationMs } : {}),
							...(activity.kind === 'fetch' && output !== undefined
								? { bytes: Buffer.byteLength(output, 'utf8') }
								: {}),
						}),
				glyph: '⎿',
				...(outputLines ? { detail: outputLines } : {}),
				...(outputLines && outputLines.length > 0 ? { meta: EXPAND_HINT } : {}),
				activity: 'web',
			},
		])
	}
	if (isTaskTool(event.toolName)) {
		// The task event already wrote the block. A listing refreshes it
		// while there is a plan to show; with none it keeps its own row.
		if (!event.isError && event.toolName !== 'task_list') return { kind: 'none' }
		if (!event.isError && ctx.hasPlan) return { kind: 'task-block' }
		// Its own row, in words: the call's label, and the result's
		// label rather than the model's receipt, which names ids.
		const said = event.resultLabel ?? (event.isError ? 'the task tool refused the call' : '')
		return rows([
			{
				role: 'tool',
				content: start?.label ?? formatToolCall(event.toolName, event.summary, true),
				glyph: '●',
				glyphColor: event.isError ? theme.status.error : theme.status.ok,
			},
			...(said.length > 0
				? [
						{
							role: 'tool' as const,
							content: event.isError ? `failed: ${said}` : said,
							glyph: '⎿',
						},
					]
				: []),
		])
	}
	if (event.declined) {
		// The person's own No: neither a failure nor a mystery. The model's
		// refusal text is for the model and is not shown. A refused edit or
		// write shows what it would have changed, dimmed.
		const refused = proposedBody(start?.proposed, ctx.cwd)
		return rows([
			{
				role: 'tool',
				content: headOf(event, start),
				glyph: '●',
				glyphColor: theme.status.error,
			},
			{
				role: 'tool',
				content: declinedLine(event.declined.note),
				glyph: '⎿',
				...(refused ? { detail: refused.rows, diff: refused.diff } : {}),
			},
		])
	}
	if (event.cancelled) {
		// A No on the tool's own screen: the person's answer, not a failure.
		return rows([
			{
				role: 'tool',
				content: headOf(event, start),
				glyph: '●',
				glyphColor: theme.text.muted,
				...(settledElapsed(event.durationMs) !== undefined
					? { meta: settledElapsed(event.durationMs) }
					: {}),
			},
			{ role: 'tool', content: event.resultLabel ?? 'Cancelled', glyph: '⎿' },
		])
	}
	if (
		!event.isError &&
		event.toolName === WORKFLOW_TOOL_NAME &&
		isBackgroundLaunch(event.output ?? '')
	) {
		// The call returned at once and the run goes on in the background.
		// What the model was told (the run's id, how it will hear back) is
		// for the model; the person gets the name and where to manage it.
		return rows([
			{
				role: 'tool',
				content: headOf(event, start),
				glyph: '●',
				glyphColor: theme.accent.assistant,
			},
			{ role: 'tool', content: WORKFLOW_BACKGROUND_NOTE, glyph: '⎿' },
		])
	}
	if (event.isError && event.toolName === WORKFLOW_TOOL_NAME && event.output !== undefined) {
		// A script that could not run: the first line of its error, after the
		// failure mark, in the error colour. Nothing is folded behind ctrl+o.
		const said = [`✘ ${firstLineOf(event.output)}`]
		return rows([
			{
				role: 'tool',
				content: headOf(event, start),
				glyph: '●',
				glyphColor: theme.status.error,
				detail: said,
				shell: failureBody(said),
			},
		])
	}
	if (event.isError && event.toolName.toLowerCase() === 'agent') {
		// A failed agent call: the error text it produced, in the error colour,
		// ten lines and then how many more ctrl+o shows.
		const text = toolFailureText(event.output, false)
		const full = toolFailureText(event.output, true).split('\n')
		const lines = text.split('\n')
		return rows([
			{
				role: 'tool',
				content: headOf(event, start),
				glyph: '●',
				glyphColor: theme.status.error,
				detail: full,
				shell: failureBody(full, text !== full.join('\n') ? lines : undefined),
			},
		])
	}
	const catalogue =
		!event.isError && event.toolName === 'agent_models' && event.output !== undefined
			? modelCatalogueView(event.output)
			: undefined
	if (catalogue !== undefined) {
		return rows([
			{
				role: 'tool',
				content: catalogue,
				glyph: '●',
				detail: event.output?.split('\n'),
				glyphColor: theme.status.ok,
				meta: EXPAND_HINT,
				activity: 'catalogue',
			},
		])
	}
	const evidence =
		!event.isError && event.output !== undefined
			? conversationEvidenceView(event.toolName, event.output)
			: undefined
	if (evidence !== undefined) {
		return rows([
			{
				role: 'tool',
				content: evidence.content,
				glyph: '●',
				detail: evidence.detail,
				glyphColor: theme.status.ok,
				meta: EXPAND_HINT,
				activity: 'evidence',
			},
		])
	}
	if (event.shell && start?.command !== undefined) {
		// One row: the header, and the `⎿` result hung under it. The dot says
		// how it ended; the elapsed time is not repeated per command.
		const failed = event.isError || event.shell.failed
		const command = start.command
		const header = command
			? formatToolCall(event.toolName, shellCommandHeader(command))
			: start.label
		const full = command ? formatToolCall(event.toolName, shellCommandFull(command)) : undefined
		// A tool that failed without an exit status (blocked, refused) has its
		// words in stdout; they read as the error they are.
		const settled: ShellOutput =
			event.isError && event.shell.stderr.length === 0
				? { ...event.shell, stdout: [], stderr: event.shell.stdout, failed: true }
				: { ...event.shell, failed }
		return rows([
			{
				role: 'tool',
				content: header,
				glyph: '●',
				detail: [...settled.stdout, ...settled.stderr],
				glyphColor: failed ? theme.status.error : theme.status.ok,
				shell: full !== undefined && full !== header ? { ...settled, fullHeader: full } : settled,
			},
		])
	}
	const elapsed = settledElapsed(event.durationMs ?? ctx.elapsedMs)
	const list: ToolRow[] = [
		{
			role: 'tool',
			content: headOf(event, start),
			glyph: '●',
			// The change to a file is drawn once, under its result.
			detail: event.diff ? undefined : start?.detail,
			glyphColor: event.isError ? theme.status.error : theme.status.ok,
			...(elapsed !== undefined ? { meta: elapsed } : {}),
		},
	]
	if (
		event.isError ||
		(!event.hidden && (event.summary.length > 0 || (event.detail?.length ?? 0) > 0))
	) {
		list.push({
			role: 'tool',
			content: event.isError
				? (event.plainFailure ?? `failed: ${withoutErrorName(event.summary)}`)
				: event.diff?.summary
					? spansText(event.diff.summary)
					: event.summary,
			glyph: '⎿',
			detail: event.detail,
			...(event.diff ? { diff: event.diff } : {}),
		})
	}
	return rows(list)
}
