/**
 * The status line's rows: each line of the command's output, dim, cut at the
 * terminal's edge, with the config's `padding` columns either side. Colours
 * from the script survive the dimming only until the script resets them, as
 * in the reference.
 */

import { Box, Text } from 'ink'

import { carryStyleAcrossLines } from './output.js'

export function StatusLineRows({
	text,
	padding = 0,
}: {
	readonly text: string
	readonly padding?: number
}) {
	return (
		<Box flexDirection="column" paddingLeft={1 + padding} paddingRight={padding}>
			{carryStyleAcrossLines(text).map((line, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity; the text is replaced whole
				<Text key={index} dimColor wrap="truncate">
					{line}
				</Text>
			))}
		</Box>
	)
}
