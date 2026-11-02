/**
 * `/resume` picker — a list of recent conversations in this folder (from
 * the SDK session store). Presentational; App owns ↑/↓/enter/esc and the
 * selected index.
 */

import { Box, Text, useStdout } from 'ink'

import { pullRequestLabel } from '../integrations/github/pull-request.js'
import { displayConversationTitle } from '../integrations/sessions/display-title.js'
import type { RecentConversation } from '../integrations/sessions/store.js'
import { boxedHintWidth, fitHints } from './key-hints.js'
import { plural } from './person-terms.js'
import {
	type ResumeScope,
	distinguishingTails,
	openingLines,
	resumeScopeLabel,
} from './resume-picker-state.js'
import { selectionWindow } from './selection-window.js'
import { theme } from './theme.js'

export interface ResumePickerProps {
	readonly conversations: readonly RecentConversation[]
	readonly selected: number
	readonly mode?: 'resume' | 'restore'
	/** What the person has typed to narrow the list. */
	readonly query?: string
	/** Which conversations are listed; the folder switch is offered only in `resume`. */
	readonly scope?: ResumeScope
	/** The name being typed for the selected conversation, or `null` when not renaming. */
	readonly renaming?: string | null
	/** A short plain line under the list, such as why Enter did nothing. */
	readonly notice?: string
}

export function ResumePicker({
	conversations,
	selected,
	mode = 'resume',
	query = '',
	scope = 'folder',
	renaming = null,
	notice,
}: ResumePickerProps) {
	const { stdout } = useStdout()
	const showPreview = (stdout.rows ?? 24) >= 20
	const { start, items: visible } = selectionWindow(conversations, selected)
	const tails = distinguishingTails(conversations)
	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
			<Box justifyContent="space-between">
				<Text color={theme.accent.user} bold>
					{mode === 'restore' ? 'Restore an archived conversation' : 'Resume a conversation'}
				</Text>
				<Text color={theme.text.muted}>
					{selected + 1}/{conversations.length}
				</Text>
			</Box>
			{renaming !== null ? (
				<Text color={theme.text.primary} wrap="truncate-end">
					<Text color={theme.accent.user}>Name: </Text>
					{renaming}
					<Text color={theme.text.muted}>▏</Text>
				</Text>
			) : (
				<Text color={theme.text.primary} wrap="truncate-end">
					<Text color={theme.accent.user}>Search: </Text>
					{query.length > 0 ? (
						<>
							{query}
							<Text color={theme.text.muted}>▏</Text>
						</>
					) : (
						<Text color={theme.text.muted}>type to search</Text>
					)}
				</Text>
			)}
			{mode === 'resume' && <Text color={theme.text.muted}>{resumeScopeLabel(scope)}</Text>}
			{conversations.length === 0 && (
				<Box paddingTop={1}>
					<Text color={theme.text.secondary}>
						{query.length > 0 ? 'No conversation matches.' : 'No conversations to show.'}
					</Text>
				</Box>
			)}
			<Box flexDirection="column" paddingTop={1}>
				{visible.map((c, visibleIndex) => {
					const index = start + visibleIndex
					return (
						<Box key={c.id}>
							<Box width={2} flexShrink={0}>
								<Text color={theme.accent.user}>{index === selected ? '›' : ' '}</Text>
							</Box>
							<Box flexGrow={1} flexShrink={1} minWidth={0}>
								<Text
									color={index === selected ? theme.text.primary : theme.text.secondary}
									bold={index === selected}
									wrap="truncate-end"
								>
									{/*
									 * A named row is quoted; a derived one is not. The two
									 * carry different promises — a name keeps meaning what
									 * it meant, and an opening message stops describing a
									 * conversation as soon as the work moves on from it —
									 * and without the mark they are one column of text
									 * that reads as if every row were chosen.
									 */}
									{c.named
										? `"${displayConversationTitle(c.title)}"`
										: displayConversationTitle(c.title)}
									{tails.has(c.id) && <Text color={theme.text.muted}> · {tails.get(c.id)}</Text>}
								</Text>
							</Box>
							{c.pr !== undefined && (
								<Text color={theme.text.muted}> {pullRequestLabel(c.pr)}</Text>
							)}
							{c.folder !== undefined && <Text color={theme.text.muted}> {c.folder}</Text>}
							<Text color={theme.text.muted}> {relativeTime(c.updatedAt)}</Text>
						</Box>
					)
				})}
			</Box>
			{showPreview && conversations[selected] && (
				<Box flexDirection="column" paddingTop={1}>
					{openingLines(conversations[selected]?.firstPrompt).map((line, lineIndex) => (
						<Text
							// biome-ignore lint/suspicious/noArrayIndexKey: the lines are a fixed prefix of one prompt
							key={lineIndex}
							color={theme.text.secondary}
							wrap="truncate-end"
						>
							{lineIndex === 0 ? `Started with: ${line}` : `              ${line}`}
						</Text>
					))}
					<Text color={theme.text.secondary} wrap="truncate-end">
						{conversations[selected]?.preview
							? `Last prompt: ${conversations[selected]?.preview}`
							: 'No saved prompt.'}
					</Text>
					<Text color={theme.text.muted} wrap="truncate-end">
						{plural(conversations[selected]?.count ?? 0, 'message')}
					</Text>
				</Box>
			)}
			{notice !== undefined && (
				<Text color={theme.status.warn} wrap="wrap">
					{notice}
				</Text>
			)}
			<Box paddingTop={1}>
				<Text color={theme.text.muted}>
					{fitHints(
						renaming !== null
							? [
									{ text: 'enter save', rank: 5 },
									{ text: 'esc cancel', short: 'esc', rank: 5 },
								]
							: [
									{ text: '↑↓ select', rank: 5 },
									{ text: `enter ${mode}`, rank: 5 },
									...(mode === 'resume'
										? [
												{
													text: scope === 'all' ? 'ctrl+a this folder' : 'ctrl+a all folders',
													short: 'ctrl+a',
													rank: 3,
												},
												// Outlasts the folder switch in a narrow terminal, and is never
												// cut down to a bare key: "ctrl+r" alone does not say what it does.
												{ text: 'ctrl+r rename', short: 'ctrl+r name', rank: 4 },
											]
										: []),
									{ text: 'PgUp/PgDn jump', rank: 1 },
									{ text: 'Home/End', rank: 1 },
									{ text: 'esc cancel', short: 'esc', rank: 5 },
								],
						boxedHintWidth(stdout.columns),
					)}
				</Text>
			</Box>
		</Box>
	)
}

function relativeTime(iso: string): string {
	const then = Date.parse(iso)
	if (Number.isNaN(then)) return ''
	const mins = Math.round((Date.now() - then) / 60000)
	if (mins < 1) return 'just now'
	if (mins < 60) return `${mins}m ago`
	const hours = Math.round(mins / 60)
	if (hours < 24) return `${hours}h ago`
	return `${Math.round(hours / 24)}d ago`
}
