/**
 * Renders parsed markdown blocks into Ink elements — the way assistant
 * replies are shown (code blocks, inline code, bold/italic, headings,
 * lists), modelled on how Claude Code / gemini-cli present text.
 *
 * Stylistic choices:
 *  - code blocks: a dim left rule + code-colored lines (no syntax
 *    highlighter dependency), with an optional language label.
 *  - inline code: a single code color, no background, so it stays legible.
 *  - headings: bold; H1/H2 take the accent color for hierarchy.
 *  - bullets: a fixed-width marker gutter so wrapped lines hang-indent.
 */

import { Box, Text } from 'ink'

import { type InlineSpan, type MdBlock, parseInline, parseMarkdown } from './markdownParser.js'
import { theme } from './theme.js'

const CODE_COLOR = theme.status.ok

export interface MarkdownProps {
	readonly text: string
	readonly color?: string
}

export function Markdown({ text, color = theme.text.primary }: MarkdownProps) {
	const blocks = parseMarkdown(text)
	return (
		<Box flexDirection="column">
			{blocks.map((block, i) => (
				<BlockView key={`b-${i}`} block={block} prev={blocks[i - 1]} color={color} />
			))}
		</Box>
	)
}

function BlockView({
	block,
	prev,
	color,
}: {
	readonly block: MdBlock
	readonly prev: MdBlock | undefined
	readonly color: string
}) {
	// One blank line between blocks, except: nothing before the first block,
	// and consecutive list items stay tight (no gap between bullets).
	const gap = !prev || (block.type === 'bullet' && prev.type === 'bullet') ? 0 : 1
	switch (block.type) {
		case 'heading':
			return (
				<Box marginTop={gap}>
					<Text bold color={block.level <= 2 ? theme.accent.user : color}>
						<Inline spans={parseInline(block.text)} color={color} />
					</Text>
				</Box>
			)
		case 'bullet': {
			const marker = block.ordered ? `${block.marker}.` : block.marker
			return (
				<Box marginTop={gap} flexDirection="row">
					<Box width={marker.length + 1} flexShrink={0}>
						<Text color={theme.text.muted}>{marker} </Text>
					</Box>
					<Box flexGrow={1}>
						<Text color={color} wrap="wrap">
							<Inline spans={parseInline(block.text)} color={color} />
						</Text>
					</Box>
				</Box>
			)
		}
		case 'code':
			return (
				<Box
					marginTop={gap}
					flexDirection="column"
					borderStyle="round"
					borderTop={false}
					borderRight={false}
					borderBottom={false}
					borderLeft={true}
					borderColor={theme.border.default}
					paddingLeft={1}
				>
					{block.lang ? <Text color={theme.text.muted}>{block.lang}</Text> : null}
					{(block.lines.length > 0 ? block.lines : ['']).map((line, i) => (
						<Text key={`c-${i}`} color={CODE_COLOR}>
							{line.length > 0 ? line : ' '}
						</Text>
					))}
				</Box>
			)
		default:
			return (
				<Box marginTop={gap}>
					<Text color={color} wrap="wrap">
						<Inline spans={parseInline(block.text)} color={color} />
					</Text>
				</Box>
			)
	}
}

function Inline({ spans, color }: { readonly spans: readonly InlineSpan[]; readonly color: string }) {
	return (
		<>
			{spans.map((span, i) => {
				if (span.code) {
					return (
						<Text key={`s-${i}`} color={CODE_COLOR}>
							{span.text}
						</Text>
					)
				}
				if (span.link) {
					// Link text in accent + underline; the URL trails dim unless it's
					// identical to the text (e.g. a bare URL link).
					return (
						<Text key={`s-${i}`}>
							<Text color={theme.accent.user} underline>
								{span.text}
							</Text>
							{span.link !== span.text ? (
								<Text color={theme.text.muted}> ({span.link})</Text>
							) : null}
						</Text>
					)
				}
				return (
					<Text key={`s-${i}`} color={color} bold={span.bold} italic={span.italic}>
						{span.text}
					</Text>
				)
			})}
		</>
	)
}
