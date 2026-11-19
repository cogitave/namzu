import { Box, Text } from 'ink'
import type { IndicatorView } from '../integrations/extensions/indicator.js'
import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'

/** `● [sentence]` for each running extension, always shown while it runs, with no setting to hide it. */
export function ExtensionIndicatorRow({ marks }: { readonly marks: readonly IndicatorView[] }) {
	if (marks.length === 0) return null
	return (
		<Box flexDirection="column">
			{marks.map((m) => (
				<Text key={m.label} wrap="truncate-end">
					<Text color={m.level === 'ok' ? theme.status.ok : theme.status.warn}>● </Text>
					<Text color={theme.text.secondary}>{terminalDisplayText(m.label)}</Text>
				</Text>
			))}
		</Box>
	)
}
