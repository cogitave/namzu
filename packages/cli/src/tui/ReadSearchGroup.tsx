import { Box, Text, useAnimation, useIsScreenReaderEnabled, useStdout } from 'ink'
import { useEffect, useState } from 'react'

import { HINT_INTERVAL_MS, groupSegments, visibleHint } from './read-search-group.js'
import { RESULT_GUTTER_INDENT, RESULT_GUTTER_WIDTH } from './system-rows.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'
import { EXPAND_HINT } from './truncation.js'
import type { TranscriptMessage } from './types.js'

/**
 * The counted line a run of reads, searches and listings leaves, and while
 * the run is open the same line in the present tense with a blinking dot and,
 * under it, the latest target.
 *
 * Settled it is one quiet line with a blank two-column slot where the dot was.
 */
export function ReadSearchGroup({
	message,
	now = Date.now,
}: {
	readonly message: TranscriptMessage
	/** The clock the hint's interval is read from; tests pass their own. */
	readonly now?: () => number
}) {
	const state = message.group
	const live = message.pending === true
	const { stdout } = useStdout()
	const screenReader = useIsScreenReaderEnabled()
	const motion =
		live &&
		stdout.isTTY === true &&
		!screenReader &&
		process.env.NO_COLOR === undefined &&
		process.env.FORCE_COLOR !== '0' &&
		process.env.TERM !== 'dumb'
	const { frame } = useAnimation({ isActive: motion, interval: 300 })
	const [, setTick] = useState(0)
	const queued = live && state?.hintQueued !== undefined ? state.hintShownAt : undefined
	// Wake once when a held hint comes due, whether or not anything animates.
	useEffect(() => {
		if (queued === undefined) return
		const timer = setTimeout(
			() => setTick((n) => n + 1),
			Math.max(0, queued + HINT_INTERVAL_MS - now()),
		)
		return () => clearTimeout(timer)
	}, [queued, now])
	if (!state) return null
	const segments = groupSegments(state, live)
	const hint = live ? visibleHint(state, now()) : undefined
	const hintLines = hint ? hint.split('\n').map(terminalDisplayText) : []
	const tone = live ? theme.text.secondary : theme.text.muted
	const blink = motion ? Math.floor(frame / 2) % 2 === 0 : true
	return (
		<Box flexDirection="column">
			<Box flexDirection="row">
				<Box width={2} flexShrink={0}>
					<Text color={theme.text.muted}>{live && blink ? '●' : ' '}</Text>
				</Box>
				<Box flexGrow={1}>
					<Text color={tone} wrap="wrap">
						{segments.map((segment, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and hold no state.
							<Text key={i} bold={segment.bold}>
								{segment.text}
							</Text>
						))}
						{live || message.meta ? (
							<Text color={theme.text.muted}> {live ? EXPAND_HINT : message.meta}</Text>
						) : null}
					</Text>
				</Box>
			</Box>
			{hintLines.length > 0 ? (
				<Box flexDirection="column" paddingLeft={RESULT_GUTTER_INDENT}>
					{hintLines.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: these rows hold no state of their own.
						<Box key={i} flexDirection="row">
							<Box width={RESULT_GUTTER_WIDTH} flexShrink={0}>
								<Text color={theme.text.muted}>{i === 0 ? '⎿' : ' '}</Text>
							</Box>
							<Text color={theme.text.muted} wrap="truncate-end">
								{line}
							</Text>
						</Box>
					))}
				</Box>
			) : null}
		</Box>
	)
}
