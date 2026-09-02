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

import type { PermissionToolCall } from './agent.js'
import {
	type PermissionReviewSummary,
	permissionReviewPageRows,
	permissionReviewRows,
} from './permission-review.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'

/** The three answers, in the order they are shown and numbered. */
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
	/** Live terminal width. Re-wrapping on resize keeps every suffix reachable. */
	readonly columns?: number
	/** Live terminal height; the pager shows as much as the screen has room for. */
	readonly rows?: number
}

function pathOf(input: unknown): string | undefined {
	if (input === null || typeof input !== 'object') return undefined
	const path = (input as { path?: unknown }).path
	return typeof path === 'string' && path.length > 0 ? path : undefined
}

/** What the box is called, from the batch's shape. */
export function permissionTitle(toolCalls: readonly PermissionToolCall[]): string {
	const first = toolCalls[0]
	if (toolCalls.length === 1 && first) {
		const path = pathOf(first.input)
		switch (first.name) {
			case 'bash':
				return 'Bash command'
			case 'edit':
				return path ? `Edit file ${path}` : 'Edit file'
			case 'write':
				return path ? `Write file ${path}` : 'Write file'
			case 'Agent':
				return 'Start an agent'
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
		switch (first.name) {
			case 'bash':
				return 'Do you want to proceed?'
			case 'edit':
				return path ? `Do you want to make this edit to ${basename(path)}?` : 'Do you want to make this edit?'
			case 'write':
				return path ? `Do you want to write ${basename(path)}?` : 'Do you want to write this file?'
			case 'Agent':
				return 'Do you want to start this agent?'
			default:
				return `Do you want to run ${first.name}?`
		}
	}
	if (toolCalls.length > 0 && toolCalls.every((call) => call.name === 'Agent')) {
		return `Do you want to start ${toolCalls.length} agents?`
	}
	return `Do you want to run these ${toolCalls.length} tools?`
}

/** The three answers, worded for the batch. */
export function permissionChoices(toolCalls: readonly PermissionToolCall[]): readonly string[] {
	const agents = toolCalls.length > 0 && toolCalls.every((call) => call.name === 'Agent')
	return [
		'Yes',
		agents ? 'Yes, and allow all tools this session' : "Yes, and don't ask again this session",
		'No, and tell namzu what to do differently (esc)',
	]
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
	columns,
	rows: terminalRows,
}: PermissionOverlayProps) {
	const pageRows = permissionReviewPageRows(terminalRows)
	const single = toolCalls.length === 1
	const source = detailsOpen ? review : readableBody(summary.text, single)
	const rows = permissionReviewRows(source, columns)
	const maxOffset = Math.max(0, rows.length - pageRows)
	const offset = Math.min(Math.max(0, reviewOffset), maxOffset)
	const visibleRows = rows.slice(offset, offset + pageRows)
	const paged = rows.length > pageRows
	const first = rows.length === 0 ? 0 : offset + 1
	const last = Math.min(rows.length, offset + pageRows)
	const destructive = toolCalls.some((call) => call.isDestructive)
	const choices = permissionChoices(toolCalls)

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={theme.status.warn}
			paddingX={1}
			marginTop={1}
		>
			<Text>
				<Text color={theme.status.warn} bold>
					{detailsOpen ? 'Exact prepared input' : terminalDisplayText(permissionTitle(toolCalls))}
				</Text>
				{destructive ? <Text color={theme.status.error}> · destructive</Text> : null}
			</Text>
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
					rows {first}-{last}/{rows.length} · PgUp/PgDn page · Home/End boundary
				</Text>
			) : null}
			<Box flexDirection="column" paddingTop={1}>
				<Text color={theme.text.primary} bold>
					{terminalDisplayText(permissionQuestion(toolCalls))}
				</Text>
				{choices.map((label, index) => {
					const selected = index === choice
					return (
						<Text key={label} color={selected ? theme.accent.user : theme.text.secondary}>
							{selected ? '❯ ' : '  '}
							{index + 1}. {label}
						</Text>
					)
				})}
			</Box>
			<Box flexDirection="column">
				<Text color={theme.text.muted}>
					↑↓ select · enter confirm · y / a / n answer · d{' '}
					{detailsOpen ? 'readable view' : 'exact input'}
				</Text>
				<Text color={theme.text.muted}>esc decline · ctrl+c decline and stop the turn</Text>
			</Box>
		</Box>
	)
}
