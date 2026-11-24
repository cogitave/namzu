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

import { Box, type DOMElement, Text } from 'ink'
import { useRef } from 'react'
import stringWidth from 'string-width'

import { ACCEPT_EDITS_TOOLS, type PermissionMode } from '../permissions/mode.js'
import { type SessionAllow, allowsForBatch, describeAllows } from '../permissions/session-allow.js'
import type { PermissionToolCall } from './agent.js'
import { connectorToolLabel } from './connector-label.js'
import { displayPath } from './display-path.js'
import { boxedHintWidth, fitHints } from './key-hints.js'
import {
	type PermissionReviewSummary,
	type WithheldCall,
	permissionReviewRows,
	reviewPageRows,
	withheldNotice,
} from './permission-review.js'
import { usePointerRegion } from './pointer/context.js'
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
	/**
	 * Which question this is when two or more are open: `position` of `total`,
	 * drawn dim and right-aligned on the title row, and dropped when the row has
	 * no room for it.
	 */
	readonly count?: { readonly position: number; readonly total: number }
	/**
	 * Who is asking when it is not the person's own conversation, as a short
	 * phrase (`from the Reviewer agent`). Host-resolved; never inferred from
	 * tool arguments.
	 */
	readonly from?: string
	/**
	 * The teammate that is asking, by name. The title then reads "<name> wants to run ..." (or says it
	 * sent a plan), so the person knows whose call this is. Host-resolved from the call's own id.
	 */
	readonly teammate?: string
	/**
	 * The person is typing why they refuse: the text so far. Absent, the
	 * answers are shown.
	 */
	readonly reason?: string
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
	/** A plain No ends the turn (the person's own conversation, asked one call at a time). */
	readonly endsTurn?: boolean
	/**
	 * A click on an answer row: the index of the row, answered as the digit on it would be. Absent
	 * where the pointer is not reported, and the rows are then not clickable.
	 */
	readonly onChoose?: (index: number) => void
	/** The working folder: the title names a file relative to it. */
	readonly cwd?: string
}

/**
 * One answer row. Where the pointer is reported a click on it chooses it, and while the pointer
 * is over it the row is lit like the one the cursor is on, without moving the cursor.
 */
function AnswerRow({
	marker,
	label,
	selected,
	onChoose,
}: {
	readonly marker: string
	readonly label: string
	readonly selected: boolean
	readonly onChoose?: () => void
}) {
	const ref = useRef<DOMElement>(null)
	const hovered = usePointerRegion(ref, {
		...(onChoose ? { onClick: () => onChoose() } : {}),
		enabled: onChoose !== undefined,
	})
	const lit = selected || hovered
	// The pointer is shown by a mark of its own as well as the colour, so a terminal without colour
	// still shows which row a click would choose.
	const shown = hovered && !selected ? `› ${marker.slice(2)}` : marker
	// The marker and the label sit in two columns, so a label that wraps
	// keeps its indent under its own first word.
	return (
		<Box ref={ref} flexDirection="row">
			<Box flexShrink={0} width={marker.length}>
				<Text color={lit ? theme.accent.user : theme.text.secondary} bold={hovered && !selected}>
					{shown}
				</Text>
			</Box>
			<Box flexGrow={1} flexShrink={1} minWidth={0}>
				<Text
					color={lit ? theme.accent.user : theme.text.secondary}
					bold={hovered && !selected}
					underline={hovered && !selected}
					wrap="wrap"
				>
					{label}
				</Text>
			</Box>
		</Box>
	)
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
export function permissionTitle(toolCalls: readonly PermissionToolCall[], cwd?: string): string {
	const first = toolCalls[0]
	if (toolCalls.length === 1 && first) {
		const asked = pathOf(first.input)
		const path = asked !== undefined && cwd !== undefined ? displayPath(asked, cwd) : asked
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
				return resumesWorkflow(first) ? 'Resume a workflow' : 'Start a workflow'
			case 'command':
				return 'Run a Namzu command'
			case 'switch_model':
				return 'Change the model'
			default:
				return connectorToolLabel(first.name)
		}
	}
	if (toolCalls.length > 0 && toolCalls.every((call) => call.name === 'Agent')) {
		return `Start ${toolCalls.length} agents`
	}
	return `${toolCalls.length} tool calls`
}

/** The name of the tool a teammate calls to send its plan for approval. */
const PLAN_TOOL = 'exit_plan_mode'

/** What the box is called when a teammate is the one asking: its name first. */
export function teammateTitle(
	name: string,
	toolCalls: readonly PermissionToolCall[],
	cwd?: string,
): string {
	const first = toolCalls[0]
	if (toolCalls.length === 1 && first) {
		if (first.name === PLAN_TOOL) return `${name} sent a plan for approval`
		const asked = pathOf(first.input)
		const path = asked !== undefined && cwd !== undefined ? displayPath(asked, cwd) : asked
		switch (first.name) {
			case 'bash':
				return `${name} wants to run a command`
			case 'edit':
				return `${name} wants to edit ${path ?? 'a file'}`
			case 'write':
				return `${name} wants to write ${path ?? 'a file'}`
			case 'Agent':
				return `${name} wants to start an agent`
			default:
				return `${name} wants to run ${browserTitle(first)?.toLowerCase() ?? connectorToolLabel(first.name)}`
		}
	}
	return `${name} wants to run ${toolCalls.length} tool calls`
}

/** Whether a `workflow` call continues an earlier run instead of starting a new one. */
function resumesWorkflow(call: PermissionToolCall | undefined): boolean {
	const input = call?.input
	return (
		typeof input === 'object' &&
		input !== null &&
		typeof (input as { resumeFromRunId?: unknown }).resumeFromRunId === 'string'
	)
}

/** The command line a `command` call stands for, as a person would type it. */
function commandLineOfInput(input: unknown): string {
	if (input === null || typeof input !== 'object') return 'a command'
	const { name, args } = input as { name?: unknown; args?: unknown }
	if (typeof name !== 'string') return 'a command'
	const words = [name, ...(Array.isArray(args) ? args.filter((a) => typeof a === 'string') : [])]
		.join(' ')
		.split(/\s+/u)
		.filter((word) => word.length > 0)
	if (words[0]?.startsWith('/')) words[0] = words[0].slice(1)
	return `/${words.join(' ')}`
}

/** The model a `switch_model` call names, with its provider when it gave one. */
function modelOfInput(input: unknown): string {
	if (input === null || typeof input !== 'object') return 'another model'
	const { model, provider } = input as { model?: unknown; provider?: unknown }
	if (typeof model !== 'string') return 'another model'
	return typeof provider === 'string' && provider.length > 0 ? `${provider}/${model}` : model
}

/** The one question under the operation. */
export function permissionQuestion(toolCalls: readonly PermissionToolCall[]): string {
	const first = toolCalls[0]
	if (toolCalls.length === 1 && first) {
		const path = pathOf(first.input)
		const browser = browserQuestion(first)
		if (browser) return browser
		switch (first.name) {
			case PLAN_TOOL:
				return 'Do you want to approve this plan?'
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
			case 'command':
				return `Do you want to run ${commandLineOfInput(first.input)}?`
			case 'switch_model':
				return `Do you want to switch this conversation to ${modelOfInput(first.input)}?`
			case 'workflow':
				return resumesWorkflow(first)
					? 'Do you want to resume this workflow?'
					: 'Do you want to start this workflow?'
			default:
				return `Do you want to run ${connectorToolLabel(first.name)}?`
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
			`Writes a protected file or folder, or creates or deletes a top-level entry of the home folder or filesystem root: ${protectedPaths.join(', ')}. Asked every time, in every mode; no earlier answer covers it.`,
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
	/** The folder the answer is saved for (`.namzu/settings.local.json` there), as the person sees it. */
	readonly rememberWhere?: string
	/** The review leaves part of this batch out, so only a one-time yes is offered. */
	readonly withheld?: boolean
	/** A plain No ends the turn, and the answer says so. */
	readonly endsTurn?: boolean
	/** The working folder: a leading `cd` to it is left out of what a remembered answer says. */
	readonly cwd?: string
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
		? resumesWorkflow(toolCalls[0])
			? 'Resume this workflow'
			: 'Start this workflow'
		: agents
			? toolCalls.length === 1
				? 'Start this agent'
				: `Start these ${toolCalls.length} agents`
			: 'Yes'
	const plan = toolCalls.length === 1 && toolCalls[0]?.name === PLAN_TOOL
	const reject = agents
		? 'Do not start'
		: plan
			? 'No, and send it back with what to change (esc)'
			: 'No, and tell Namzu what to do differently (esc)'
	// A plan is approved one at a time: nothing about it is remembered.
	const extra =
		options.batchOnly || options.withheld || plan ? undefined : extraAnswer(toolCalls, options)
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
				(call.isDestructive !== true || call.name === 'write') &&
				call.requiresApproval !== true &&
				call.authorization?.explicitReview !== true,
		)
	)
		return { label: 'Yes, and switch to accept edits for this session', kind: 'approve-edits' }
	if (options.commandArguments === undefined) return undefined
	const allows = allowsForBatch(toolCalls, options.commandArguments)
	if (!allows) return undefined
	return {
		label: `Yes, and don't ask again for ${describeAllows(allows, options.cwd)} ${options.rememberWhere ? `in ${options.rememberWhere}` : 'this session'}`,
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

/**
 * The text the review pager shows. A workflow whose first part does not fit
 * the page gets the compact arrangement of the same words, so the name, the
 * purpose, the phases and the limits come before anything a person can do
 * without. The pager keys and the box read the text through here, so they
 * always agree on how many rows there are.
 */
export function permissionReviewSource(args: {
	readonly summary: PermissionReviewSummary
	readonly review: string
	readonly detailsOpen: boolean
	readonly single: boolean
	readonly columns: number | undefined
	readonly pageRows: number
}): string {
	const { summary, review, detailsOpen, single, columns, pageRows } = args
	if (detailsOpen)
		return summary.expandedText !== undefined ? readableBody(summary.expandedText, single) : review
	if (summary.compactText !== undefined) return summary.compactText
	if (
		single &&
		summary.shortText !== undefined &&
		summary.headText !== undefined &&
		permissionReviewRows(readableBody(summary.headText, single), columns).length > pageRows
	)
		return readableBody(summary.shortText, single)
	return readableBody(summary.text, single)
}

export function PermissionOverlay({
	toolCalls,
	review,
	summary,
	detailsOpen,
	reviewOffset = 0,
	choice = 0,
	count,
	from,
	teammate,
	reason,
	columns,
	rows: terminalRows,
	batchOnly = false,
	mode,
	commandArguments,
	rememberWhere,
	siteNotes = [],
	screenConsent,
	withheld = [],
	endsTurn = false,
	onChoose,
	cwd,
}: PermissionOverlayProps) {
	const single = toolCalls.length === 1
	const compact = !detailsOpen && summary.compactText !== undefined
	const sharing = screenConsent !== undefined
	const answerOptions: PermissionAnswerOptions = {
		batchOnly,
		screenConsent: sharing,
		withheld: withheld.length > 0,
		endsTurn,
		...(mode ? { mode } : {}),
		...(commandArguments ? { commandArguments } : {}),
		...(rememberWhere ? { rememberWhere } : {}),
		...(cwd ? { cwd } : {}),
	}
	const answers = permissionAnswers(toolCalls, answerOptions)
	const answerCount = answers.length
	const pageRows = Math.max(1, reviewPageRows(toolCalls, terminalRows, answerCount))
	const source = permissionReviewSource({
		summary,
		review,
		detailsOpen,
		single,
		columns,
		pageRows,
	})
	const scriptView = summary.expandedText !== undefined
	const rows = permissionReviewRows(source, columns)
	const maxOffset = Math.max(0, rows.length - pageRows)
	const offset = Math.min(Math.max(0, reviewOffset), maxOffset)
	const visibleRows = rows.slice(offset, offset + pageRows)
	const paged = rows.length > pageRows
	const first = rows.length === 0 ? 0 : offset + 1
	const last = Math.min(rows.length, offset + pageRows)
	const destructive = toolCalls.some((call) => call.isDestructive)
	const choices = answers.map((answer) => answer.label)
	const onRefusal = answers[choice]?.kind === 'reject'
	const offersEdits = answers.some((answer) => answer.kind === 'approve-edits')
	const typing = reason !== undefined
	const escalationNotes = permissionEscalationNotes(toolCalls)
	const sharingNotes = sharing ? screenConsentNotes(screenConsent.provider) : []

	const titleText = detailsOpen
		? scriptView
			? 'Workflow script'
			: 'Exact prepared input'
		: sharing
			? 'Share your screen'
			: terminalDisplayText(
					teammate !== undefined
						? teammateTitle(teammate, toolCalls, cwd)
						: permissionTitle(toolCalls, cwd),
				)
	const destructiveText = destructive
		? toolCalls.every((call) => call.name === 'write')
			? summary.text.includes('New file')
				? ' · new file'
				: ' · may overwrite'
			: ' · destructive'
		: ''
	const countText = count ? `${count.position} of ${count.total}` : undefined
	// "k of N" earns its place only while it fits next to the title and who is
	// asking; it is dropped, not shortened, when it does not.
	const countFits =
		countText !== undefined &&
		stringWidth(`${titleText}${destructiveText}${from ? ` · ${terminalDisplayText(from)}` : ''}`) +
			1 +
			stringWidth(countText) <=
			boxedHintWidth(columns)
	const shownCount = countFits ? countText : undefined

	return (
		<Box
			flexDirection="column"
			borderStyle={compact ? 'single' : 'round'}
			borderColor={compact ? theme.text.muted : theme.status.warn}
			paddingX={1}
			marginTop={1}
		>
			<Box flexDirection="row">
				<Box flexShrink={1} flexGrow={1} minWidth={0}>
					<Text wrap="truncate-end">
						<Text color={theme.status.warn} bold>
							{titleText}
						</Text>
						{destructive ? <Text color={theme.status.error}>{destructiveText}</Text> : null}
						{from ? (
							<Text color={theme.text.muted}>{` · ${terminalDisplayText(from)}`}</Text>
						) : null}
					</Text>
				</Box>
				{shownCount ? (
					<Box flexShrink={0} marginLeft={1}>
						<Text color={theme.text.muted}>{shownCount}</Text>
					</Box>
				) : null}
			</Box>
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
			{withheld.length > 0 ? (
				<Text color={theme.text.muted}>
					{terminalDisplayText(withheldNotice(withheld, toolCalls.length))}
				</Text>
			) : null}
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
			{typing ? (
				<Box flexDirection="column" paddingTop={1}>
					<Text color={theme.text.primary} bold>
						Tell Namzu what to do differently
					</Text>
					<Box flexDirection="row">
						<Box flexShrink={0} width={2}>
							<Text color={theme.accent.user}>❯ </Text>
						</Box>
						<Box flexGrow={1} flexShrink={1} minWidth={0}>
							<Text color={theme.text.primary} wrap="wrap">
								{terminalDisplayText(reason)}
								<Text color={theme.accent.user}>▌</Text>
							</Text>
						</Box>
					</Box>
				</Box>
			) : (
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
						return (
							<AnswerRow
								key={label}
								marker={marker}
								label={label}
								selected={selected}
								{...(onChoose ? { onChoose: () => onChoose(index) } : {})}
							/>
						)
					})}
				</Box>
			)}
			<Box flexDirection="column">
				<Text color={theme.text.muted}>
					{/* The answer keys are the last to go: this is the one screen where a
					    missing hint costs an approval. Then the key that stops the reply,
					    which is not `esc` (esc cancels and the agent carries on). The
					    detail toggle says itself short first. The keys still act when
					    their hint is gone.
					    A workflow review loses hints in this order as the width falls:
					    `↑↓ select`, `ctrl+c stop`, `y / n answer` (said as `y / n` before
					    it goes), then `esc cancel` (the key still cancels, and Escape is
					    a convention people know), then `d script`, the only key that
					    shows the whole script, and last `enter confirm`. */}
					{fitHints(
						typing
							? [
									{ text: 'enter send', rank: 5 },
									{ text: 'esc back', rank: 5 },
									{ text: 'ctrl+c stop', rank: 4 },
								]
							: [
									// The arrow keys are the first of the answer keys to go: enter and y / n
									// still answer, and the list shows which row is selected.
									{ text: '↑↓ select', rank: scriptView ? 2 : 3 },
									{ text: 'enter confirm', rank: scriptView ? 7 : 5 },
									{
										text: 'y / n answer',
										short: 'y / n',
										// The script key outranks it on a workflow review: at a narrow
										// width it is the only key that shows what will run.
										rank: scriptView ? 4 : 5,
									},
									{ text: 'esc cancel', rank: 5 },
									...(onChoose ? [{ text: 'click an answer', short: 'click', rank: 2 }] : []),
									...(offersEdits ? [{ text: 'shift+tab accept edits', rank: 3 }] : []),
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
										// whose key works without being shown. On a workflow review it
										// also outlasts `esc cancel`: nothing else shows the whole
										// script, and Escape cancels without its hint.
										rank: scriptView ? 6 : 5,
									},
									// On the No row the way to give a reason is the one hint that cannot be
									// guessed, so it outlasts the arrows and the stop key. Last of its rank,
									// it gives way first, and says less before it does.
									...(onRefusal ? [{ text: 'tab say why', short: 'tab why', rank: 5 }] : []),
								],
						boxedHintWidth(columns),
					)}
				</Text>
			</Box>
		</Box>
	)
}
