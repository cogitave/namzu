/**
 * Multi-line text input at the bottom of the TUI. Ink's `useInput` covers
 * everything we need in M3 (single-line edits, Enter to submit, backspace,
 * Esc to clear, history nav) without adding another dep. Vim mode, paste,
 * autocomplete come in later sessions if user UX needs them.
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
			// Ignore other meta keys; only append printable input.
			if (key.ctrl || key.meta) return
			if (input.length === 0) return
			setValue((v) => v + input)
		},
		{ isActive: true },
	)

	const prompt = disabled ? '… ' : '> '
	return (
		<Box>
			<Text color={theme.accent.user}>{prompt}</Text>
			<Text color={disabled ? theme.text.muted : theme.text.primary}>
				{value}
				<Text color={theme.border.focus}>▏</Text>
			</Text>
		</Box>
	)
}
