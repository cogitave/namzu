/**
 * A small, single-line text prompt for host-owned decisions.
 *
 * This is intentionally not the main composer wearing a different label. A
 * value entered here is never a model prompt, never enters prompt history, and
 * never participates in the follow-up queue. The caller owns the durable side
 * effect; this component owns only an editable buffer and explicit accept or
 * cancel.
 */

import { Box, Text, useInput, useWindowSize } from 'ink'
import { useCallback, useRef, useState } from 'react'

import {
	choiceDisplayText,
	choiceDisplayWidth,
	truncateChoiceText,
} from './terminal-choice-text.js'
import { theme } from './theme.js'

export interface TextPromptProps {
	readonly title: string
	readonly placeholder: string
	readonly initialValue?: string
	readonly emptyNotice?: string
	/** Stay mounted while a higher-priority permission prompt owns the screen. */
	readonly hidden?: boolean
	/** Width available after the parent's padding. */
	readonly columns?: number
	readonly onSubmit: (value: string) => void
	readonly onCancel: () => void
}

const graphemeSegmenter = new Intl.Segmenter(undefined, {
	granularity: 'grapheme',
})

function previousBoundary(source: string, cursor: number): number {
	let previous = 0
	for (const segment of graphemeSegmenter.segment(source)) {
		if (segment.index >= cursor) break
		previous = segment.index
	}
	return previous
}

function nextBoundary(source: string, cursor: number): number {
	for (const segment of graphemeSegmenter.segment(source)) {
		const end = segment.index + segment.segment.length
		if (end > cursor) return end
	}
	return source.length
}

function previousWordBoundary(source: string, cursor: number): number {
	let start = cursor
	while (start > 0) {
		const previous = previousBoundary(source, start)
		if (!/\s/u.test(source.slice(previous, start))) break
		start = previous
	}
	while (start > 0) {
		const previous = previousBoundary(source, start)
		if (/\s/u.test(source.slice(previous, start))) break
		start = previous
	}
	return start
}

/** A viewport around the cursor; source text and its grapheme boundaries stay intact. */
function visibleInput(source: string, cursor: number, columns: number) {
	const segments = [...graphemeSegmenter.segment(source)].map(({ segment, index }) => ({
		index,
		text: choiceDisplayText(segment),
		width: choiceDisplayWidth(segment),
	}))
	segments.push({ index: source.length, text: ' ', width: 1 })
	const current = Math.max(
		0,
		segments.findIndex(({ index }) => index >= cursor),
	)
	const under = segments[current]!
	if (columns < under.width + 2) {
		return { before: '', under: truncateChoiceText(under.text, columns), after: '' }
	}
	let start = 0
	let end = segments.length
	if (segments.reduce((sum, segment) => sum + segment.width, 0) > columns) {
		// Leave room for both omission markers; share the remaining cells around
		// the cursor, then use spare room on either side at the start or end.
		const available = columns - 2
		let used = under.width
		start = current
		end = current + 1
		while (start > 0 && used + segments[start - 1]!.width <= Math.floor(available / 2)) {
			used += segments[--start]!.width
		}
		while (end < segments.length && used + segments[end]!.width <= available) {
			used += segments[end++]!.width
		}
		while (start > 0 && used + segments[start - 1]!.width <= available) {
			used += segments[--start]!.width
		}
	}
	return {
		before: `${start > 0 ? '…' : ''}${segments
			.slice(start, current)
			.map(({ text }) => text)
			.join('')}`,
		under: under.text,
		after: `${segments
			.slice(current + 1, end)
			.map(({ text }) => text)
			.join('')}${end < segments.length ? '…' : ''}`,
	}
}

export function TextPrompt({
	title,
	placeholder,
	initialValue = '',
	emptyNotice = 'A value is required. Press Esc to cancel.',
	hidden = false,
	columns,
	onSubmit,
	onCancel,
}: TextPromptProps) {
	const terminal = useWindowSize()
	const contentWidth = Math.max(1, (columns ?? terminal.columns ?? 80) - 4)
	const inputWidth = Math.max(1, contentWidth - 2)
	const [value, setValueState] = useState(initialValue)
	const valueRef = useRef(initialValue)
	const [cursor, setCursorState] = useState(initialValue.length)
	const cursorRef = useRef(initialValue.length)
	const [notice, setNotice] = useState<string | null>(null)

	const setBuffer = useCallback((next: string, nextCursor = next.length) => {
		valueRef.current = next
		cursorRef.current = nextCursor
		setValueState(next)
		setCursorState(nextCursor)
		setNotice(null)
	}, [])

	const setCursor = useCallback((next: number) => {
		cursorRef.current = next
		setCursorState(next)
	}, [])

	useInput(
		(input, key) => {
			if (key.escape || (key.ctrl && input === 'c')) {
				onCancel()
				return
			}
			if (key.return) {
				const submitted = valueRef.current.trim()
				if (submitted.length === 0) {
					setNotice(emptyNotice)
					return
				}
				onSubmit(submitted)
				return
			}
			if (key.backspace) {
				const position = cursorRef.current
				const previous = previousBoundary(valueRef.current, position)
				setBuffer(valueRef.current.slice(0, previous) + valueRef.current.slice(position), previous)
				return
			}
			if (key.delete || (key.ctrl && input === 'd')) {
				const position = cursorRef.current
				const next = nextBoundary(valueRef.current, position)
				setBuffer(valueRef.current.slice(0, position) + valueRef.current.slice(next), position)
				return
			}
			if (key.ctrl && input === 'w') {
				const position = cursorRef.current
				const previous = previousWordBoundary(valueRef.current, position)
				setBuffer(valueRef.current.slice(0, previous) + valueRef.current.slice(position), previous)
				return
			}
			if (key.ctrl && input === 'u') {
				const position = cursorRef.current
				setBuffer(valueRef.current.slice(position), 0)
				return
			}
			if (key.leftArrow || (key.ctrl && input === 'b')) {
				setCursor(previousBoundary(valueRef.current, cursorRef.current))
				return
			}
			if (key.rightArrow || (key.ctrl && input === 'f')) {
				setCursor(nextBoundary(valueRef.current, cursorRef.current))
				return
			}
			if (key.home || (key.ctrl && input === 'a')) {
				setCursor(0)
				return
			}
			if (key.end || (key.ctrl && input === 'e')) {
				setCursor(valueRef.current.length)
				return
			}
			if (key.ctrl || key.meta || input.length === 0) return
			// This prompt is deliberately one line. Terminal paste can contain CRLF;
			// collapse it to the same spaces `/rename <name>` would receive.
			const inserted = input.replace(/[\r\n]+/g, ' ')
			const position = cursorRef.current
			setBuffer(
				valueRef.current.slice(0, position) + inserted + valueRef.current.slice(position),
				position + inserted.length,
			)
		},
		{ isActive: !hidden },
	)

	// Keeping the component mounted is what preserves an in-progress name if a
	// higher-priority permission request briefly takes over the screen.
	if (hidden) return null

	const visible = visibleInput(value, cursor, inputWidth)

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
			<Text color={theme.accent.user} bold>
				{truncateChoiceText(title, contentWidth)}
			</Text>
			<Box paddingTop={1}>
				<Box width={2} flexShrink={0}>
					<Text color={theme.accent.user}>› </Text>
				</Box>
				{value.length === 0 ? (
					<Text>
						<Text inverse> </Text>
						<Text color={theme.text.muted}>{truncateChoiceText(placeholder, inputWidth - 1)}</Text>
					</Text>
				) : (
					<Text>
						{visible.before}
						<Text inverse>{visible.under}</Text>
						{visible.after}
					</Text>
				)}
			</Box>
			{notice ? (
				<Box paddingTop={1}>
					<Text color={theme.status.warn}>{truncateChoiceText(notice, contentWidth)}</Text>
				</Box>
			) : null}
			<Box paddingTop={1}>
				<Text color={theme.text.muted}>
					{truncateChoiceText(
						contentWidth >= 43
							? 'enter save · esc cancel · Ctrl+W delete word'
							: 'enter save · esc cancel',
						contentWidth,
					)}
				</Text>
			</Box>
		</Box>
	)
}
