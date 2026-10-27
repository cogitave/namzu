/**
 * The plan approval box: the plan the model wrote, and the way out of plan mode.
 *
 * Shaped like the permission box beside it — a titled box, the thing itself in
 * a fixed-height pager, one question, a numbered choice with a cursor — and
 * quiet in the same way: the plan mode's own colour for the frame, plain text
 * for the plan, no fills. It owns its keys while it is up and App steps aside,
 * as it does for the skill-save box.
 *
 * Keys: ↑/↓ or 1-3 pick a row, Enter takes it, PgUp/PgDn page the plan, Esc
 * keeps planning without a word, Ctrl+C stops the reply. The last row is a text
 * row: type what to change and press Enter, and the words go back to the model.
 * Shift+Tab approves the first row with whatever is typed. Approving waits out the settle window
 * every consent screen waits out,
 * so a key already in flight cannot approve a plan its owner has not read;
 * refusing never waits.
 */

import { Box, Text, useInput } from 'ink'
import { useRef, useState } from 'react'

import {
	KEEP_PLANNING_PLACEHOLDER,
	type PlanApprovalAnswer,
	type PlanApprovalRequest,
	planApprovalRows,
} from '../plan/approval.js'
import { approvalIsDeliberate } from './consent-timing.js'
import { isSessionPlanPath } from './display-path.js'
import { boxedHintWidth, fitHints } from './key-hints.js'
import { permissionReviewRows } from './permission-review.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'

export interface PlanApprovalOverlayProps {
	readonly request: PlanApprovalRequest
	readonly columns?: number
	readonly rows?: number
	readonly onAnswer: (answer: PlanApprovalAnswer) => void
	/** Ctrl+C: stop the reply this plan belongs to. */
	readonly onInterrupt?: () => void
	/** The clock the settle window reads; tests pass their own. */
	readonly now?: () => number
}

/** Rows the box spends on everything but the plan. */
const CHROME_ROWS = 14

/** How many rows of the plan fit on a screen `terminalRows` tall. */
export function planPageRows(terminalRows: number | undefined): number {
	return Math.max(4, Math.min(30, (terminalRows ?? 24) - CHROME_ROWS))
}

export function PlanApprovalOverlay({
	request,
	columns,
	rows: terminalRows,
	onAnswer,
	onInterrupt,
	now = Date.now,
}: PlanApprovalOverlayProps) {
	const choices = planApprovalRows(request.bypassAvailable)
	const textRow = choices.length - 1
	const [cursor, setCursor] = useState(0)
	const [text, setText] = useState('')
	const [offset, setOffset] = useState(0)
	const shownAt = useRef(now())

	const pageRows = planPageRows(terminalRows)
	const planRows = permissionReviewRows(request.plan.trimEnd(), columns)
	const maxOffset = Math.max(0, planRows.length - pageRows)
	const top = Math.min(offset, maxOffset)
	const visible = planRows.slice(top, top + pageRows)
	const paged = planRows.length > pageRows

	const feedback = text.trim()
	const approve = (index: number, withText: boolean): void => {
		if (!approvalIsDeliberate(shownAt.current, now())) return
		const row = choices[index]
		if (!row?.mode) return
		onAnswer({
			kind: 'approve',
			mode: row.mode,
			...(withText && feedback ? { feedback } : {}),
		})
	}

	useInput((input, key) => {
		if (key.ctrl && input === 'c') {
			onInterrupt?.()
			return
		}
		if (key.escape) {
			onAnswer({ kind: 'keep-planning' })
			return
		}
		if (key.shift && key.tab) {
			approve(0, true)
			return
		}
		if (key.pageUp) {
			setOffset(Math.max(0, top - pageRows))
			return
		}
		if (key.pageDown) {
			setOffset(Math.min(maxOffset, top + pageRows))
			return
		}
		if (key.upArrow) {
			setCursor((value) => Math.max(0, value - 1))
			return
		}
		if (key.downArrow || key.tab) {
			setCursor((value) => Math.min(textRow, value + 1))
			return
		}
		if (key.return) {
			if (cursor === textRow) {
				// An empty row is not an answer: "keep planning" says what to change.
				if (feedback) onAnswer({ kind: 'keep-planning', feedback })
				return
			}
			approve(cursor, false)
			return
		}
		if (cursor === textRow) {
			if (key.backspace || key.delete) {
				setText((value) => [...value].slice(0, -1).join(''))
				return
			}
			if (key.ctrl && input === 'u') {
				setText('')
				return
			}
			if (key.ctrl && input === 'w') {
				setText((value) => value.replace(/\s*\S*$/u, ''))
				return
			}
		}
		if (key.ctrl || key.meta || input.length === 0) return
		// A digit on a row is a pick; on the text row it is text.
		if (cursor !== textRow && /^[1-9]$/.test(input)) {
			const index = Number(input) - 1
			if (index >= choices.length) return
			if (index === textRow) setCursor(textRow)
			else approve(index, false)
			return
		}
		// Typing starts the feedback, wherever the cursor was.
		setCursor(textRow)
		setText((value) => value + input.replace(/[\r\n]+/g, ' '))
	})

	const hintWidth = boxedHintWidth(columns)
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={theme.accent.plan}
			paddingX={1}
			marginTop={1}
		>
			<Text color={theme.accent.plan} bold>
				Plan ready for review
			</Text>
			{isSessionPlanPath(request.planPath) ? null : (
				<Text color={theme.text.secondary} wrap="truncate-start">
					{terminalDisplayText(request.planPath)}
				</Text>
			)}
			<Box flexDirection="column" paddingLeft={2} paddingTop={1}>
				{visible.map((row) => (
					<Box key={row.index} width="100%">
						<Text color={theme.text.primary} bold={!row.continuation && /^#{1,6}\s/.test(row.text)}>
							{row.continuation ? `↳ ${row.text}` : row.text.length > 0 ? row.text : ' '}
						</Text>
					</Box>
				))}
			</Box>
			{paged ? (
				<Text color={theme.text.muted}>
					rows {top + 1}-{Math.min(planRows.length, top + pageRows)}/{planRows.length} · PgUp/PgDn
					page
				</Text>
			) : null}
			<Box flexDirection="column" paddingTop={1}>
				<Text color={theme.text.primary} bold>
					Do you want to start on this plan?
				</Text>
				{choices.map((row, index) => {
					const selected = index === cursor
					const color = selected ? theme.accent.user : theme.text.secondary
					if (index !== textRow) {
						return (
							<Text key={row.id} color={color}>
								{selected ? '❯ ' : '  '}
								{index + 1}. {row.label}
							</Text>
						)
					}
					return (
						<Text key={row.id} color={color}>
							{selected ? '❯ ' : '  '}
							{index + 1}. {row.label}
							{text.length > 0 || selected ? ': ' : ''}
							{text.length > 0 ? (
								<Text color={theme.text.primary}>{terminalDisplayText(text)}</Text>
							) : selected ? (
								<Text color={theme.text.muted}>{KEEP_PLANNING_PLACEHOLDER}</Text>
							) : null}
							{selected ? <Text inverse> </Text> : null}
						</Text>
					)
				})}
			</Box>
			<Text color={theme.text.muted}>
				{fitHints(
					[
						{ text: '↑↓ select', rank: 5 },
						{ text: 'enter confirm', rank: 5 },
						{ text: 'esc cancel', rank: 5 },
						{
							text: 'shift+tab approve with note',
							short: 'shift+tab',
							rank: 2,
						},
						{ text: 'ctrl+c stop', rank: 4 },
					],
					hintWidth,
				)}
			</Text>
		</Box>
	)
}
