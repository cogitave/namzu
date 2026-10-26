import { Box, Text } from 'ink'

import { type ContextListGroup, type ContextView, formatTokens } from './context-grid.js'
import { paint, theme } from './theme.js'

/** The tree under a list's title: `├` for each item but the last, `└` for the last. */
function Group({ group }: { readonly group: ContextListGroup }) {
	return (
		<Box flexDirection="column">
			{group.heading ? <Text dimColor>{group.heading}</Text> : null}
			{group.items.map((item, index) => (
				<Text key={`${item.label}-${index}`}>
					<Text color={theme.text.muted}>{index === group.items.length - 1 ? '└ ' : '├ '}</Text>
					{item.label}
					<Text dimColor>{`: ${item.value}`}</Text>
				</Text>
			))}
		</Box>
	)
}

/** `/context`: the grid with its legend beside it, the lists, and the advice. */
export function ContextGridRow({ view }: { readonly view: ContextView }) {
	return (
		<Box flexDirection="column" paddingLeft={1}>
			<Text bold>Context usage</Text>
			{view.overLimit ? <Text color={theme.status.error}>{view.overLimit}</Text> : null}
			<Box flexDirection="row" columnGap={2}>
				<Box flexDirection="column" flexShrink={0}>
					{view.cells.map((row, rowIndex) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: grid cells have no identity beyond their place.
						<Text key={rowIndex}>
							{row.map((cell, cellIndex) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: grid cells have no identity beyond their place.
								<Text key={cellIndex} color={paint(cell.color)} dimColor={cell.dim}>
									{`${cell.glyph} `}
								</Text>
							))}
						</Text>
					))}
				</Box>
				<Box flexDirection="column" flexShrink={1}>
					{view.model ? <Text dimColor>{view.model}</Text> : null}
					<Text dimColor>{view.usage}</Text>
					<Text> </Text>
					<Text italic dimColor>
						Estimated usage by category
					</Text>
					{view.legend.map((line) => (
						<Text key={line.name}>
							<Text color={paint(line.color)} dimColor={line.dimGlyph}>{`${line.glyph} `}</Text>
							<Text dimColor={line.dimName}>{`${line.name}: `}</Text>
							<Text dimColor>{line.value}</Text>
						</Text>
					))}
				</Box>
			</Box>
			{view.windowNote ? (
				<Box marginTop={1}>
					<Text>
						<Text bold>{view.windowNote.label}</Text>
						<Text dimColor>{view.windowNote.value}</Text>
					</Text>
				</Box>
			) : null}
			{view.sections.map((section) => (
				<Box key={section.title} flexDirection="column" marginTop={1}>
					<Text>
						<Text bold>{section.title}</Text>
						<Text dimColor>{` · ${section.hint}`}</Text>
					</Text>
					{section.groups.map((group, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: groups are positional.
						<Group key={index} group={group} />
					))}
				</Box>
			))}
			{view.suggestions.length > 0 ? (
				<Box flexDirection="column" marginTop={1}>
					<Text bold>Suggestions</Text>
					{view.suggestions.map((suggestion) => (
						<Box key={suggestion.title} flexDirection="column">
							<Text>
								<Text color={suggestion.level === 'warning' ? theme.status.warn : theme.text.muted}>
									{suggestion.level === 'warning' ? '⚠ ' : 'ℹ '}
								</Text>
								<Text bold>{suggestion.title}</Text>
								{suggestion.savings > 0 ? (
									<Text dimColor>{` → save ~${formatTokens(suggestion.savings)}`}</Text>
								) : null}
							</Text>
							<Text dimColor>{`  ${suggestion.detail}`}</Text>
						</Box>
					))}
				</Box>
			) : null}
			{view.notes && view.notes.length > 0 ? (
				<Box flexDirection="column" marginTop={1}>
					{view.notes.map((line) => (
						<Text key={line} dimColor>
							{line}
						</Text>
					))}
				</Box>
			) : null}
		</Box>
	)
}
