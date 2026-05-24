/**
 * Single-line composer with input history. Ink `useInput` covers all
 * keys we need; no extra `ink-text-input` dep. Enter submits, Esc clears,
 * Up/Down browse history, Backspace deletes.
 */

import { Box, Text, useInput } from 'ink'
import { useCallback, useState } from 'react'

import { theme } from './theme.js'

export interface ComposerProps {
	readonly disabled?: boolean
	readonly onSubmit: (value: string) => void
	readonly history: readonly string[]
}

export function Composer({ disabled = false, onSubmit, history }: ComposerProps) {
	const [value, setValue] = useState<string>('')
	const [historyIndex, setHistoryIndex] = useState<number>(-1)

	const reset = useCallback(() => {
		setValue('')
		setHistoryIndex(-1)
	}, [])

	useInput(
		(input, key) => {
			if (disabled) return
			if (key.return) {
				if (value.trim().length === 0) return
				onSubmit(value)
				reset()
				return
			}
			if (key.escape) {
				reset()
				return
			}
			if (key.backspace || key.delete) {
				setValue((v) => v.slice(0, -1))
				return
			}
			if (key.upArrow) {
				if (history.length === 0) return
				const next = Math.min(historyIndex + 1, history.length - 1)
				setHistoryIndex(next)
				setValue(history[history.length - 1 - next] ?? '')
				return
			}
			if (key.downArrow) {
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
			setValue((v) => v + input)
		},
		{ isActive: true },
	)

	const promptGlyph = disabled ? '…' : '>'
	const showPlaceholder = !disabled && value.length === 0
	return (
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
	)
}
