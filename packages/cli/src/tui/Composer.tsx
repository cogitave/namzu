/**
 * Single-line composer with input history and slash-command autocomplete.
 * Ink `useInput` covers all keys we need; no extra `ink-text-input` dep.
 *
 * Keys: Enter submits (or runs the highlighted command while the
 * autocomplete dropdown is open), Tab completes the highlighted command,
 * Esc clears / closes the dropdown, ↑/↓ navigate the dropdown when open
 * else browse history, Backspace deletes.
 */

import { Box, Text, useInput } from 'ink'
import { useCallback, useState } from 'react'

import { matchSlashCommands } from './slashCommands.js'
import { theme } from './theme.js'

export interface ComposerProps {
	readonly disabled?: boolean
	readonly onSubmit: (value: string) => void
	readonly history: readonly string[]
}

const MAX_SUGGESTIONS = 6
// A single keypress longer than this (with no newline) is treated as a paste.
const PASTE_THRESHOLD = 80

export function Composer({ disabled = false, onSubmit, history }: ComposerProps) {
	const [value, setValue] = useState<string>('')
	const [historyIndex, setHistoryIndex] = useState<number>(-1)
	const [selected, setSelected] = useState<number>(0)
	// Large pastes are held as attachments (shown as chips) instead of being
	// dumped into the input, then folded into the message on submit.
	const [pastes, setPastes] = useState<readonly string[]>([])

	const suggestions = matchSlashCommands(value).slice(0, MAX_SUGGESTIONS)
	const showSuggestions = suggestions.length > 0
	const selIdx = Math.min(selected, Math.max(0, suggestions.length - 1))

	const reset = useCallback(() => {
		setValue('')
		setHistoryIndex(-1)
		setSelected(0)
		setPastes([])
	}, [])

	useInput(
		(input, key) => {
			if (disabled) return
			if (key.return) {
				if (showSuggestions) {
					// Run the highlighted command.
					onSubmit(`/${suggestions[selIdx]?.name ?? ''}`)
					reset()
					return
				}
				const message = [value, ...pastes].map((s) => s.trim()).filter(Boolean).join('\n\n')
				if (message.length === 0) return
				onSubmit(message)
				reset()
				return
			}
			if (key.tab) {
				if (showSuggestions) {
					// Complete to the highlighted command, ready for arguments.
					setValue(`/${suggestions[selIdx]?.name ?? ''} `)
					setSelected(0)
				}
				return
			}
			if (key.escape) {
				reset()
				return
			}
			if (key.backspace || key.delete) {
				// Backspace on an empty line removes the last pasted attachment.
				if (value.length === 0 && pastes.length > 0) {
					setPastes((p) => p.slice(0, -1))
					return
				}
				setValue((v) => v.slice(0, -1))
				return
			}
			if (key.upArrow) {
				if (showSuggestions) {
					setSelected((i) => Math.max(0, i - 1))
					return
				}
				if (history.length === 0) return
				const next = Math.min(historyIndex + 1, history.length - 1)
				setHistoryIndex(next)
				setValue(history[history.length - 1 - next] ?? '')
				return
			}
			if (key.downArrow) {
				if (showSuggestions) {
					setSelected((i) => Math.min(suggestions.length - 1, i + 1))
					return
				}
				if (historyIndex <= 0) {
					reset()
					return
				}
				const next = historyIndex - 1
				setHistoryIndex(next)
				setValue(history[history.length - 1 - next] ?? '')
				return
			}
			if (key.ctrl || key.meta) return
			if (input.length === 0) return
			// A multi-line or large chunk arriving in one keypress is a paste —
			// hold it as an attachment chip instead of flooding the input.
			if (input.includes('\n') || input.length > PASTE_THRESHOLD) {
				setPastes((p) => [...p, input])
				return
			}
			setSelected(0)
			setValue((v) => v + input)
		},
		{ isActive: true },
	)

	const promptGlyph = disabled ? '…' : '>'
	const showPlaceholder = !disabled && value.length === 0
	return (
		<Box flexDirection="column">
			{pastes.length > 0 ? (
				<Box flexDirection="column" paddingX={1} paddingBottom={1}>
					{pastes.map((p, i) => (
						<Text key={`paste-${i}`} color={theme.text.secondary}>
							⎘ Pasted text #{i + 1} (+{p.split('\n').length} lines)
						</Text>
					))}
				</Box>
			) : null}
			<Box paddingX={1}>
				<Box width={2} flexShrink={0}>
					<Text color={disabled ? theme.text.muted : theme.accent.user} bold>
						{promptGlyph}
					</Text>
				</Box>
				<Box flexGrow={1}>
					{showPlaceholder ? (
						<Text color={theme.text.muted}>Type a message… (/help for commands)</Text>
					) : (
						<Text color={disabled ? theme.text.muted : theme.text.primary} wrap="wrap">
							{value}
							{disabled ? null : <Text color={theme.border.focus}>▏</Text>}
						</Text>
					)}
				</Box>
			</Box>
			{showSuggestions ? (
				<Box flexDirection="column" paddingX={1} paddingTop={1}>
					{suggestions.map((cmd, i) => (
						<Box key={cmd.name}>
							<Box width={12} flexShrink={0}>
								<Text
									color={i === selIdx ? theme.accent.user : theme.text.secondary}
									bold={i === selIdx}
								>
									{i === selIdx ? '› ' : '  '}/{cmd.name}
								</Text>
							</Box>
							<Text color={theme.text.muted}>{cmd.description}</Text>
						</Box>
					))}
				</Box>
			) : null}
		</Box>
	)
}
