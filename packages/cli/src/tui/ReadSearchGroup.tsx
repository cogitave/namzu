import { Box, Text, useAnimation, useIsScreenReaderEnabled, useStdout } from 'ink'

import { useContentWidth } from './Markdown.js'
import { motionAllowed, useReducedMotion } from './motion.js'
import { COMMAND_ROW_INDENT, commandRows, groupSegments, visibleHint } from './read-search-group.js'
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
export function ReadSearchGroup({ message }: { readonly message: TranscriptMessage }) {
	const state = message.group
	const live = message.pending === true
	// Redraws when the setting changes, so a blinking dot stops at once.
	useReducedMotion()
	const { stdout } = useStdout()
	const width = useContentWidth()
	const screenReader = useIsScreenReaderEnabled()
	const motion = live && stdout.isTTY === true && !screenReader && motionAllowed()
	const { frame } = useAnimation({ isActive: motion, interval: 300 })
	if (!state) return null
	const segments = groupSegments(state, live)
	const hint = live ? visibleHint(state) : undefined
	const hintLines = hint ? hint.split('\n').map(terminalDisplayText) : []
	// The commands it ran, one row each and cut to the width, then the newest target.
	const ran = message.detailExpanded
		? []
		: commandRows(state, width - COMMAND_ROW_INDENT).map(terminalDisplayText)
	const under = [
		...ran.map((text) => ({ text, wrap: 'truncate-end' as const })),
		...hintLines.map((text) => ({ text, wrap: 'wrap' as const })),
	]
	// The detailed transcript is where the hint points: it never points at itself.
	const shownHint = message.detailExpanded ? undefined : live ? EXPAND_HINT : message.meta
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
						{shownHint ? <Text color={theme.text.muted}> {shownHint}</Text> : null}
					</Text>
				</Box>
			</Box>
			{under.length > 0 ? (
				<Box flexDirection="column" paddingLeft={RESULT_GUTTER_INDENT}>
					{under.map(({ text: line, wrap }, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: these rows hold no state of their own.
						<Box key={i} flexDirection="row">
							<Box width={RESULT_GUTTER_WIDTH} flexShrink={0}>
								<Text color={theme.text.muted}>{i === 0 ? '⎿' : ' '}</Text>
							</Box>
							<Box flexGrow={1}>
								<Text color={theme.text.muted} wrap={wrap}>
									{line}
								</Text>
							</Box>
						</Box>
					))}
				</Box>
			) : null}
		</Box>
	)
}
