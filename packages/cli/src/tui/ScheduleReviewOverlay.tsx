/**
 * A bounded, keyboard-owned review of a scheduled job.
 * The short summary stays visible while the complete host-computed proposal
 * scrolls below it. The source is never clipped or replaced by a summary.
 */

import type { ScheduleJobPreview } from '@namzu/sdk'
import { Box, Text, useInput } from 'ink'
import { useMemo, useState } from 'react'

import { wrapExact } from './SaveSkillOverlay.js'
import { terminalDisplayText } from './terminal-display.js'
import { truncateChoiceText } from './terminal-choice-text.js'
import { theme } from './theme.js'

export interface ScheduleReviewRequest {
	readonly action: 'create' | 'update' | 'confirm'
	/** A manual `/schedule add` is requested by the operator, not the model. */
	readonly proposedByModel?: boolean
	readonly preview: ScheduleJobPreview
	readonly promptFindings?: readonly string[]
	/** The entire host-computed confirmation, with invisible characters exposed. */
	readonly fullText: string
	readonly permissionsChange?: boolean
}

export type ScheduleReviewAnswer = 'cancel' | 'create-paused' | 'create' | 'save'

export interface ScheduleReviewOverlayProps {
	readonly request: ScheduleReviewRequest
	readonly columns?: number
	readonly rows?: number
	readonly onAnswer: (answer: ScheduleReviewAnswer) => void
}

function choices(action: ScheduleReviewRequest['action']): readonly {
	readonly answer: ScheduleReviewAnswer
	readonly label: string
}[] {
	return action === 'create'
		? [
				{ answer: 'cancel', label: 'Cancel' },
				{ answer: 'create-paused', label: 'Create paused' },
				{ answer: 'create', label: 'Create' },
			]
		: action === 'confirm'
			? [
					{ answer: 'cancel', label: 'Cancel' },
					{ answer: 'create-paused', label: 'Confirm paused' },
					{ answer: 'create', label: 'Confirm' },
				]
			: [
				{ answer: 'cancel', label: 'Cancel' },
				{ answer: 'save', label: 'Save change' },
		]
}

/** The fixed part names the decision and the consequences before any scrolling. */
export function scheduleReviewSummary(request: ScheduleReviewRequest): readonly string[] {
	const { preview } = request
	const script = preview.runKind === 'script' || preview.runKind === 'script+agent'
	const kind = preview.runKind === 'script' ? 'Fixed script' : preview.runKind === 'script+agent' ? 'Script gate + agent' : 'Agent'
	const browser = preview.warnings.some((warning) => warning.startsWith('This run drives the browser signed in as you'))
	const otherWarnings = new Set(
		preview.warnings.filter(
			(warning) =>
				warning !== 'This run can reach the network.' &&
				warning !== 'The folder is outside this session’s working directory and added directories.' &&
				!warning.startsWith('This run drives the browser signed in as you'),
		),
	)
	const findings = new Set(request.promptFindings ?? [])
	return [
		`${request.action === 'confirm' ? 'Confirm' : request.action === 'create' ? 'Create' : 'Update'} “${preview.name}” · ${request.action === 'confirm' ? 'review this saved job' : request.proposedByModel === false ? 'requested by you' : 'proposed by the model'} · runs later unattended`,
		`When    ${preview.schedule}`,
		preview.workspace === 'none'
			? 'Workspace  Private scheduler workspace (no project)'
			: `Folder  ${preview.folder}`,
		...(preview.delivery?.kind === 'source-conversation'
			? [`Results  Source conversation ${preview.delivery.sessionId}`]
			: []),
		`Run     ${kind}${script ? ` (${preview.script?.shell ?? 'shell'} on this machine)` : ` (${preview.model ?? 'model'})`}`,
		...(preview.script?.report === 'json-v1'
			? ['Script report  JSON v1: quiet/changed; optional scheduler state.']
			: []),
		...(preview.networkAccess ? ['Network  This run can reach the network.'] : []),
		...(preview.notifyOnFinish === false
			? ['Notices  Generic success notices off; failures still notify.']
			: []),
		...(request.permissionsChange ? ['Permissions change from the next run.'] : []),
		...(preview.outsideSessionRoots ? ['Warning  Folder is outside this session’s working directory and added directories.'] : []),
		...(browser ? ['Warning  A signed-in browser profile may be used; inspect its sites and access levels below.'] : []),
		...(findings.size > 0 ? [`Warning  ${findings.size} prompt finding${findings.size === 1 ? '' : 's'}; read the full text below.`] : []),
		...(otherWarnings.size > 0 ? [`Warning  ${otherWarnings.size} other warning${otherWarnings.size === 1 ? '' : 's'}; read details below.`] : []),
		...(script
			? preview.runKind === 'script'
				? [
						preview.workspace === 'none'
							? 'Script: host process as your user; private workspace is cwd, not a write boundary.'
							: 'Script: host process as your user; folder is cwd, not a write boundary.',
						'Checks: shell commands meet floor + deny rules; interpreter code needs your review.',
						'Allow, ask and unmatched rules do not limit this script.',
					]
				: [
						'Gate: host process as your user; folder is cwd, not a write boundary.',
						'Gate checks: shell commands meet floor + deny rules; interpreter code needs your review.',
						'Agent phase: the permission set governs its tools.',
					]
			: []),
	]
}

function compactSummary(request: ScheduleReviewRequest): readonly string[] {
	const { preview } = request
	const warningCount = new Set([
		...preview.warnings.filter((warning) => warning !== 'This run can reach the network.'),
		...(request.promptFindings ?? []),
	]).size
	const script = preview.runKind === 'script' || preview.runKind === 'script+agent'
	return [
		`${request.action === 'confirm' ? 'Confirm' : request.action === 'create' ? 'Create' : 'Update'} · ${request.action === 'confirm' ? 'saved job' : request.proposedByModel === false ? 'your job' : 'model-proposed job'} ${preview.name}`,
		...(preview.delivery?.kind === 'source-conversation' ? [`Results → source conversation ${preview.delivery.sessionId}`] : []),
		...(script
			? [preview.workspace === 'none'
				? 'Host script · private no-project workspace; host authority'
				: 'Host script · folder is cwd, not a write boundary']
			: [`When ${preview.schedule}`]),
		...(script ? ['Shell checks only; interpreter code needs review'] : []),
		...(preview.script?.report === 'json-v1' ? ['JSON v1 report · quiet/changed'] : []),
		`${preview.networkAccess ? 'Network access · ' : ''}${warningCount} warning${warningCount === 1 ? '' : 's'} · read details`,
	]
}

export function ScheduleReviewOverlay({ request, columns, rows, onAnswer }: ScheduleReviewOverlayProps) {
	const width = Math.max(20, (columns ?? 80) - 4)
	const options = choices(request.action)
	const [selected, setSelected] = useState(0)
	const [offset, setOffset] = useState(0)
	const [reachedEnd, setReachedEnd] = useState(false)
	const terminalRows = rows ?? 24
	const canReview = terminalRows >= 14 && (columns ?? 80) >= 60
	const summary = scheduleReviewSummary(request)
	const fullSummaryRows = summary.flatMap((line) => wrapExact(line, width))
	const maxSummaryRows = Math.max(0, terminalRows - 8)
	const summaryRows = fullSummaryRows.length <= maxSummaryRows
		? fullSummaryRows
		: compactSummary(request)
				.slice(0, maxSummaryRows)
				.map((line) => ({ text: truncateChoiceText(terminalDisplayText(line), width), continued: false }))
	// The full original text is retained. wrapExact marks continuation rows, so
	// a visual line wrap cannot be mistaken for a newline in a shell script.
	const body = useMemo(() => wrapExact(request.fullText, width - 2), [request.fullText, width])
	const chrome = summaryRows.length + 5
	const window = Math.max(1, terminalRows - chrome)
	const last = Math.max(0, body.length - window)
	const top = Math.min(offset, last)
	const visible = body.slice(top, top + window)
	const reviewed = reachedEnd || last === 0
	const moveTo = (next: number) => {
		setOffset(next)
		if (next >= last) setReachedEnd(true)
	}

	useInput((input, key) => {
		if (!canReview) {
			if (key.escape || key.return || (key.ctrl && input === 'c')) onAnswer('cancel')
			return
		}
		if (key.escape || (key.ctrl && input === 'c')) {
			onAnswer('cancel')
			return
		}
		if (key.return) {
			if (selected === 0) onAnswer('cancel')
			else if (reviewed) onAnswer(options[selected]?.answer ?? 'cancel')
			return
		}
		if (/^[1-3]$/.test(input)) {
			const index = Number(input) - 1
			if (index < options.length) setSelected(index)
			return
		}
		if (key.leftArrow || (key.tab && key.shift)) {
			setSelected((index) => (index + options.length - 1) % options.length)
			return
		}
		if (key.rightArrow || key.tab) {
			setSelected((index) => (index + 1) % options.length)
			return
		}
		if (key.upArrow) moveTo(Math.max(0, top - 1))
		else if (key.downArrow) moveTo(Math.min(last, top + 1))
		else if (key.pageUp) moveTo(Math.max(0, top - window))
		else if (key.pageDown) moveTo(Math.min(last, top + window))
		else if (key.home || input === 'g') moveTo(0)
		else if (key.end || input === 'G') moveTo(last)
	})
	if (!canReview) {
		return (
			<Box flexDirection="column" borderStyle="round" borderColor={theme.status.warn} paddingX={1}>
				<Text color={theme.status.warn} bold>Scheduled job review needs more room</Text>
				<Text>Resize the terminal to at least 62 columns and 16 rows to inspect the full proposal.</Text>
				<Text color={theme.text.muted}>Enter or Esc cancels; no job is created or changed.</Text>
			</Box>
		)
	}

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.status.warn} paddingX={1}>
			{summaryRows.map((row, index) => (
				<Text
					// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional.
					key={`s${index}`}
					bold={index === 0}
					color={index === 0 || row.text.startsWith('Network') || row.text.startsWith('Permissions change') || row.text.startsWith('Script')
						? theme.status.warn
						: theme.text.secondary}
				>
					{row.continued ? '┆ ' : ''}{row.text}
				</Text>
			))}
			<Text color={theme.text.muted}>
				{truncateChoiceText(`Full proposal · rows ${body.length ? top + 1 : 0}–${Math.min(body.length, top + window)} of ${body.length}`, width)}
			</Text>
			{visible.map((row, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional.
				<Text key={`b${top + index}`}>
					<Text color={theme.text.muted}>{row.continued ? '┆ ' : '│ '}</Text>
					{row.text || ' '}
				</Text>
			))}
			<Box>
				{options.map((option, index) => (
					<Box key={option.answer} marginRight={1}>
						<Text color={index > 0 && !reviewed ? theme.text.muted : index === selected ? theme.accent.user : theme.text.secondary} inverse={index === selected}>
							{` ${index + 1} ${option.label} `}
						</Text>
					</Box>
				))}
			</Box>
			<Text color={theme.text.muted}>
				{truncateChoiceText(reviewed
					? '←/→ choose · enter apply · ↑/↓ PgUp/PgDn · g/G ends · esc cancel'
					: `Scroll to the end to enable ${request.action === 'confirm' ? 'Confirm' : request.action === 'create' ? 'Create' : 'Save'} · G to end · esc cancel`, width)}
			</Text>
		</Box>
	)
}
