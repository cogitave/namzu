/**
 * The consent box: what the model wants to do, and the three answers.
 *
 * Shaped like the prompt an operator already knows from other coding
 * agents — a titled box naming the operation, the operation itself in the
 * plainest form the tool allows (the command, the diff, the file), one
 * question, and a numbered choice with a cursor on the answer most people
 * give. App owns every key; this is presentational.
 *
 * Nothing here decides what is SHOWN: the readable text is the kernel-side
 * envelope's projection from `permission-review.ts`, and the exact envelope
 * is one key away. What this file decides is how it reads.
 */

import { basename } from 'node:path'

import { Box, Text } from 'ink'

import { ACCEPT_EDITS_TOOLS, type PermissionMode } from '../permissions/mode.js'
import { type SessionAllow, allowsForBatch, describeAllows } from '../permissions/session-allow.js'
import type { PermissionToolCall } from './agent.js'
import { boxedHintWidth, fitHints } from './key-hints.js'
import {
	type PermissionReviewSummary,
	WITHHELD_NOTICE,
	type WithheldCall,
	permissionReviewPageRows,
	permissionReviewRows,
} from './permission-review.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'

/** The answers, in the order they are shown and numbered: three, or two for a batch-only prompt. */
export type PermissionChoice = 0 | 1 | 2

export interface PermissionOverlayProps {
	readonly toolCalls: readonly PermissionToolCall[]
	/** Complete exact review envelope built before the callback was opened. */
	readonly review: string
	/** Readable projection derived only from `review`. */
	readonly summary: PermissionReviewSummary
	/** Unknown/evolved shapes begin here so no formatter can hide input. */
	readonly detailsOpen: boolean
	/** First physical row shown in the fixed-height pager. */
	readonly reviewOffset?: number
	/** Which answer the cursor is on. */
	readonly choice?: PermissionChoice
	readonly queuedCount?: number
	/** Host-resolved owner; never inferred from tool arguments. */
	readonly sourceLabel?: string
	/** Live terminal width. Re-wrapping on resize keeps every suffix reachable. */
	readonly columns?: number
	/** Live terminal height; the pager shows as much as the screen has room for. */
	readonly rows?: number
	/** Answers this batch only: no session-wide answer is offered (a scheduled run). */
	readonly batchOnly?: boolean
	/** The session's mode now; the accept-edits answer is offered only from `prompt`. */
	readonly mode?: PermissionMode
	/** Present when the session can remember allows; see `permissionAnswers`. */
	readonly commandArguments?: ReadonlyMap<string, string>
	/** The folder the remembered answer is saved for, as the person sees it. */
	readonly rememberWhere?: string
	/** Which browser site rule decided each browser call, with the profile and engine. */
	readonly siteNotes?: readonly string[]
	/**
	 * This batch would show the model the screen for the first time in the
	 * session (`ToolReviewRequest.screenConsent`); `provider` is who receives
	 * it, as the session names its provider.
	 */
	readonly screenConsent?: { readonly provider: string | null }
	/**
	 * Calls whose input is too large to show in full. Each gets a notice, and
	 * the prompt offers only the answers that apply once.
	 */
	readonly withheld?: readonly WithheldCall[]
}

/** What the box says when the question is whether to share the screen. */
export function screenConsentNotes(provider: string | null): readonly string[] {
	return [
		`namzu will see your screen and send it to ${provider ?? 'the model provider'} for this conversation: screenshots, the titles of open windows and the controls of the windows it reads.`,
		'Asked once per conversation. Clicks, typing and other changes are still asked about.',
	]
}

function pathOf(input: unknown): string | undefined {
	if (input === null || typeof input !== 'object') return undefined
	const path = (input as { path?: unknown }).path
	return typeof path === 'string' && path.length > 0 ? path : undefined
}

function actionOf(input: unknown): string | undefined {
	if (input === null || typeof input !== 'object') return undefined
	const action = (input as { action?: unknown }).action
	return typeof action === 'string' ? action : undefined
}

function originOf(input: unknown): string | undefined {
	if (input === null || typeof input !== 'object') return undefined
	const origin = (input as { origin?: unknown }).origin
	return typeof origin === 'string' && origin.length > 0 ? origin : undefined
}

/** A browser call in words a person reads at a glance; `undefined` for any other tool. */
function browserTitle(call: PermissionToolCall): string | undefined {
	const action = actionOf(call.input)
	if (call.name === 'browser') {
		switch (action) {
			case 'navigate':
				return 'Open a web page'
			case 'tabs':
				return 'Open a web page in a new tab'
			case 'back':
				return 'Go back in the browser'
			case 'forward':
				return 'Go forward in the browser'
			case 'reload':
				return 'Reload the page'
			default:
				return 'Use the browser'
		}
	}
	if (call.name === 'browser_act') {
		const where = originOf(call.input)
		const verb =
			action === 'click'
				? 'Click'
				: action === 'type'
					? 'Type'
					: action === 'fill_form'
						? 'Fill a form'
						: action === 'select'
							? 'Choose an option'
							: action === 'press'
								? 'Press a key'
								: action === 'upload'
									? 'Upload a file'
									: action === 'dialog'
										? 'Answer a dialog'
										: 'Change the page'
		return where ? `${verb} on ${where}` : verb
	}
	return undefined
}

function browserQuestion(call: PermissionToolCall): string | undefined {
	if (call.name === 'browser') {
		switch (actionOf(call.input)) {
			case 'navigate':
			case 'tabs':
				return 'Do you want to open this page?'
			case 'back':
				return 'Do you want to go back?'
			case 'forward':
				return 'Do you want to go forward?'
			case 'reload':
				return 'Do you want to reload the page?'
			default:
				return 'Do you want to use the browser?'
		}
	}
	if (call.name === 'browser_act') {
		const where = originOf(call.input)
		return where ? `Do you want to do this on ${where}?` : 'Do you want to change the page?'
	}
	return undefined
}

/** What the box is called, from the batch's shape. */
export function permissionTitle(toolCalls: readonly PermissionToolCall[]): string {
	const first = toolCalls[0]
	if (toolCalls.length === 1 && first) {
		const path = pathOf(first.input)
		const browser = browserTitle(first)
		if (browser) return browser
		switch (first.name) {
			case 'bash':
				return 'Bash command'
			case 'edit':
				return path ? `Edit file ${path}` : 'Edit file'
			case 'write':
				return path ? `Write file ${path}` : 'Write file'
			case 'Agent':
				return 'Start an agent'
			case 'workflow':
				return 'Start a workflow'
			default:
				return first.name
		}
	}
	if (toolCalls.length > 0 && toolCalls.every((call) => call.name === 'Agent')) {
		return `Start ${toolCalls.length} agents`
	}
	return `${toolCalls.length} tool calls`
}

/** The one question under the operation. */
export function permissionQuestion(toolCalls: readonly PermissionToolCall[]): string {
	const first = toolCalls[0]
	if (toolCalls.length === 1 && first) {
		const path = pathOf(first.input)
		const browser = browserQuestion(first)
		if (browser) return browser
		switch (first.name) {
			case 'bash':
				return 'Do you want to proceed?'
			case 'edit':
				return path
					? `Do you want to make this edit to ${basename(path)}?`
					: 'Do you want to make this edit?'
			case 'write':
				// The title names the file; the question does not repeat it.
				return 'Do you want to write this file?'
			case 'Agent':
				return 'Do you want to start this agent?'
			case 'workflow':
				return 'Do you want to start this workflow?'
			default:
				return `Do you want to run ${first.name}?`
		}
	}
	if (toolCalls.length > 0 && toolCalls.every((call) => call.name === 'Agent')) {
		return `Do you want to start ${toolCalls.length} agents?`
	}
	return `Do you want to run these ${toolCalls.length} tools?`
}

/**
 * What the batch reaches past the turn's boundary, one line each, or none.
 *
 * Said above the operation rather than left to be read out of it: a path in
 * a JSON body does not look outside the project, and a boolean named
 * `dangerously_disable_sandbox` at the end of a long command is easy to miss.
 */
export function permissionEscalationNotes(toolCalls: readonly PermissionToolCall[]): string[] {
	const notes: string[] = []
	if (toolCalls.some((call) => call.escalation?.sandboxEscape === true)) {
		notes.push(
			'Runs OUTSIDE the sandbox, on this machine. Asked every time; no earlier answer covers it.',
		)
	}
	const outside = toolCalls.flatMap((call) => call.escalation?.outsidePaths ?? [])
	if (outside.length > 0) {
		notes.push(
			`Outside the working directory: ${outside.join(', ')}. Asked every time; no earlier answer covers it.`,
		)
	}
	const protectedPaths = toolCalls.flatMap((call) => call.escalation?.protectedPaths ?? [])
	if (protectedPaths.length > 0) {
		notes.push(
			`Writes a protected file or folder: ${protectedPaths.join(', ')}. Asked every time, in every mode; no earlier answer covers it.`,
		)
	}
	if (toolCalls.some((call) => call.escalation?.dangerousRemoval !== undefined)) {
		notes.push(
			'Removes something that should not be removed by accident (the home folder, the working folder or a parent, or a path a variable could empty). Asked every time; no earlier answer covers it.',
		)
	}
	return notes
}

/**
 * What an answer on the screen does. `approve-edits` switches the session to
 * accept-edits and `approve-rule` remembers the allows it carries, both for
 * the rest of the session; each also approves this batch. There is no
 * "allow every tool" answer: there is none.
 */
export type PermissionAnswerKind = 'approve' | 'approve-edits' | 'approve-rule' | 'reject'

export interface PermissionAnswer {
	readonly label: string
	readonly kind: PermissionAnswerKind
	/** What `approve-rule` remembers. */
	readonly allows?: readonly SessionAllow[]
}

export interface PermissionAnswerOptions {
	readonly batchOnly?: boolean
	readonly screenConsent?: boolean
	/** The session's mode now; the edit answer is offered only from `prompt`. */
	readonly mode?: PermissionMode
	/** Tools whose command line is one argument, when this session can remember allows. */
	readonly commandArguments?: ReadonlyMap<string, string>
	/** The folder the answer is saved for (`namzu.config.local.json` there), as the person sees it. */
	readonly rememberWhere?: string
	/** The review leaves part of this batch out, so only a one-time yes is offered. */
	readonly withheld?: boolean
}

/**
 * The answers, in the order they are shown and numbered, with what each
 * does. Yes and No always; between them, at most one that is valid for every
 * call in the batch: switch to accept edits (every call a plain edit or
 * write, from `prompt`), or remember an allow for the rest of the session
 * (every call a plain command, fetch or MCP call). A call that crosses the
 * turn's boundary, asks by rule, or must always be asked, gets neither. A
 * `batchOnly` prompt (a scheduled run's) offers neither.
 */
export function permissionAnswers(
	toolCalls: readonly PermissionToolCall[],
	options: PermissionAnswerOptions = {},
): readonly PermissionAnswer[] {
	// A yes to sharing the screen is its own answer, never a wider one given
	// in passing.
	if (options.screenConsent)
		return [
			{ label: 'Yes, share my screen for this conversation', kind: 'approve' },
			{ label: 'No, and tell Namzu what to do differently (esc)', kind: 'reject' },
		]
	const workflow = toolCalls.length === 1 && toolCalls[0]?.name === 'workflow'
	const agents =
		workflow || (toolCalls.length > 0 && toolCalls.every((call) => call.name === 'Agent'))
	const approve = workflow
		? 'Start this workflow'
		: agents
			? toolCalls.length === 1
				? 'Start this agent'
				: `Start these ${toolCalls.length} agents`
			: 'Yes'
	const reject = agents ? 'Do not start' : 'No, and tell Namzu what to do differently (esc)'
	const extra = options.batchOnly || options.withheld ? undefined : extraAnswer(toolCalls, options)
	return [
		{ label: approve, kind: 'approve' },
		...(extra ? [extra] : []),
		{ label: reject, kind: 'reject' },
	]
}

function extraAnswer(
	toolCalls: readonly PermissionToolCall[],
	options: PermissionAnswerOptions,
): PermissionAnswer | undefined {
	if (
		options.mode === 'prompt' &&
		toolCalls.length > 0 &&
		toolCalls.every(
			(call) =>
				ACCEPT_EDITS_TOOLS.has(call.name) &&
				call.escalation === undefined &&
				call.isDestructive !== true &&
				call.requiresApproval !== true &&
				call.authorization?.explicitReview !== true,
		)
	)
		return { label: 'Yes, and switch to accept edits for this session', kind: 'approve-edits' }
	if (options.commandArguments === undefined) return undefined
	const allows = allowsForBatch(toolCalls, options.commandArguments)
	if (!allows) return undefined
	return {
		label: `Yes, and don't ask again for ${describeAllows(allows)} ${options.rememberWhere ? `in ${options.rememberWhere}` : 'this session'}`,
		kind: 'approve-rule',
		allows,
	}
}

/** The answers' labels, in order. */
export function permissionChoices(
	toolCalls: readonly PermissionToolCall[],
	options: PermissionAnswerOptions = {},
): readonly string[] {
	return permissionAnswers(toolCalls, options).map((answer) => answer.label)
}

/**
 * The readable text, without the batch furniture a single call does not
 * need: its `1. name` heading says what the title already says, and the
 * three-space indent under it exists to set calls apart from each other.
 */
function readableBody(summaryText: string, single: boolean): string {
	if (!single) return summaryText
	const lines = summaryText.split('\n')
	const body = lines.length > 1 && /^1\. /.test(lines[0] ?? '') ? lines.slice(1) : lines
	return body.map((line) => (line.startsWith('   ') ? line.slice(3) : line)).join('\n')
}

/**
 * A change row reads as a change: removed text red, added text green. Only in
 * the readable view — the exact view is JSON, where a `-` at column one is a
 * value, not a sign — and only on the summary's own `+ ` / `- ` prefixes,
 * which sit at column one for a single call and column four in a batch.
 */
function rowColor(text: string, detailsOpen: boolean): string {
	if (detailsOpen) return theme.text.secondary
	if (/^(\s{3})?- /.test(text)) return theme.status.error
	if (/^(\s{3})?\+ /.test(text)) return theme.status.ok
	return theme.text.primary
}

export function PermissionOverlay({
	toolCalls,
	review,
	summary,
	detailsOpen,
	reviewOffset = 0,
	choice = 0,
	queuedCount = 0,
	sourceLabel,
	columns,
	rows: terminalRows,
	batchOnly = false,
	mode,
	commandArguments,
	rememberWhere,
	siteNotes = [],
	screenConsent,
	withheld = [],
}: PermissionOverlayProps) {
	const pageRows = Math.max(1, permissionReviewPageRows(terminalRows) - (sourceLabel ? 1 : 0))
	const single = toolCalls.length === 1
	const compact = !detailsOpen && summary.compactText !== undefined
	const source = detailsOpen
		? summary.expandedText !== undefined
			? readableBody(summary.expandedText, single)
			: review
		: (summary.compactText ?? readableBody(summary.text, single))
	const scriptView = summary.expandedText !== undefined
	const rows = permissionReviewRows(source, columns)
	const maxOffset = Math.max(0, rows.length - pageRows)
	const offset = Math.min(Math.max(0, reviewOffset), maxOffset)
	const visibleRows = rows.slice(offset, offset + pageRows)
	const paged = rows.length > pageRows
	const first = rows.length === 0 ? 0 : offset + 1
	const last = Math.min(rows.length, offset + pageRows)
	const destructive = toolCalls.some((call) => call.isDestructive)
	const sharing = screenConsent !== undefined
	const choices = permissionChoices(toolCalls, {
		batchOnly,
		screenConsent: sharing,
		withheld: withheld.length > 0,
		...(mode ? { mode } : {}),
		...(commandArguments ? { commandArguments } : {}),
		...(rememberWhere ? { rememberWhere } : {}),
	})
	const escalationNotes = permissionEscalationNotes(toolCalls)
	const sharingNotes = sharing ? screenConsentNotes(screenConsent.provider) : []

	return (
		<Box
			flexDirection="column"
			borderStyle={compact ? 'single' : 'round'}
			borderColor={compact ? theme.text.muted : theme.status.warn}
			paddingX={1}
			marginTop={1}
		>
			<Text>
				<Text color={theme.status.warn} bold>
					{detailsOpen
						? scriptView
							? 'Workflow script'
							: 'Exact prepared input'
						: sharing
							? 'Share your screen'
							: terminalDisplayText(permissionTitle(toolCalls))}
				</Text>
				{queuedCount > 0 ? (
					<Text color={theme.text.muted}> · {queuedCount} more awaiting approval</Text>
				) : null}
				{destructive ? (
					<Text color={theme.status.error}>
						{toolCalls.every((call) => call.name === 'write')
							? summary.text.includes('New file')
								? ' · new file'
								: ' · may overwrite'
							: ' · destructive'}
					</Text>
				) : null}
			</Text>
			{sourceLabel ? (
				<Text color={theme.text.secondary} wrap="truncate-end">
					{terminalDisplayText(sourceLabel)}
				</Text>
			) : null}
			{sharingNotes.map((note) => (
				<Text key={note} color={theme.text.primary}>
					{terminalDisplayText(note)}
				</Text>
			))}
			{escalationNotes.map((note) => (
				<Text key={note} color={theme.status.error}>
					{terminalDisplayText(note)}
				</Text>
			))}
			{withheld.map((call) => (
				<Text key={`withheld-${call.index}`} color={theme.text.muted}>
					{terminalDisplayText(
						withheld.length > 1 || toolCalls.length > 1
							? `${call.index + 1}. ${call.name}: ${WITHHELD_NOTICE}`
							: WITHHELD_NOTICE,
					)}
				</Text>
			))}
			{siteNotes.map((note) => (
				<Text key={note} color={theme.text.secondary}>
					{terminalDisplayText(note)}
				</Text>
			))}
			<Box flexDirection="column" paddingLeft={2}>
				{visibleRows.map((row) => (
					<Box key={row.index} width="100%">
						<Text color={rowColor(row.text, detailsOpen)}>
							{row.continuation ? `↳ ${row.text}` : row.text}
						</Text>
					</Box>
				))}
			</Box>
			{paged ? (
				<Text color={theme.text.muted}>
					rows {first}-{last}/{rows.length} · PgUp/PgDn page · Home/End
				</Text>
			) : null}
			<Box flexDirection="column" paddingTop={1}>
				{!compact ? (
					<Text color={theme.text.primary} bold>
						{terminalDisplayText(
							sharing
								? 'Let Namzu see your screen for the rest of this conversation?'
								: permissionQuestion(toolCalls),
						)}
					</Text>
				) : null}
				{choices.map((label, index) => {
					const selected = index === choice
					const marker = `${selected ? '❯ ' : '  '}${index + 1}. `
					// The marker and the label sit in two columns, so a label that wraps
					// keeps its indent under its own first word.
					return (
						<Box key={label} flexDirection="row">
							<Box flexShrink={0} width={marker.length}>
								<Text color={selected ? theme.accent.user : theme.text.secondary}>{marker}</Text>
							</Box>
							<Box flexGrow={1} flexShrink={1} minWidth={0}>
								<Text color={selected ? theme.accent.user : theme.text.secondary} wrap="wrap">
									{label}
								</Text>
							</Box>
						</Box>
					)
				})}
			</Box>
			<Box flexDirection="column">
				<Text color={theme.text.muted}>
					{/* The answer keys are the last to go: this is the one screen where a
					    missing hint costs an approval. Then the key that stops the reply,
					    which is not `esc` (esc cancels and the agent carries on). The
					    detail toggle says itself short first. The keys still act when
					    their hint is gone. */}
					{fitHints(
						[
							{ text: '↑↓ select', rank: 5 },
							{ text: 'enter confirm', rank: 5 },
							{
								text: 'y / n answer',
								short: 'y / n',
								// The script key outranks it on a workflow review: at a narrow
								// width it is the only key that shows what will run.
								rank: scriptView ? 4 : 5,
							},
							{ text: 'esc cancel', short: 'esc', rank: 5 },
							{
								text: 'ctrl+c stop',
								rank: scriptView ? 3 : 4,
							},
							{
								text: `d ${
									scriptView
										? detailsOpen
											? 'collapse'
											: 'script'
										: detailsOpen
											? 'readable'
											: compact
												? 'instructions'
												: 'view input'
								}`,
								short: `d ${scriptView ? (detailsOpen ? 'collapse' : 'script') : detailsOpen ? 'readable' : compact ? 'full' : 'input'}`,
								// The only way to the exact input: it outranks the stop hint,
								// whose key works without being shown.
								rank: 5,
							},
						],
						boxedHintWidth(columns),
					)}
				</Text>
			</Box>
		</Box>
	)
}
