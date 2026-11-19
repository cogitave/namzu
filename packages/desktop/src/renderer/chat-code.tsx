import { getSharedHighlighter } from '@pierre/diffs'
import { type ReactNode, useEffect, useState } from 'react'
import {
	type HighlightToken,
	createBlockHighlighter,
	themeForMode,
	useWindowDark,
} from './code-highlight.js'
import { useCodePrefs } from './code-prefs.js'

const blockHighlighter = createBlockHighlighter(async (theme, lang) => {
	const highlighter = await getSharedHighlighter({
		themes: [theme],
		langs: [lang],
		preferredHighlighter: 'shiki-wasm',
	})
	return highlighter
})

interface Drawn {
	text: string
	fence: string
	lines: HighlightToken[][]
}

/**
 * The coloured children of a reply's code block, or undefined while the block stays plain: not yet
 * settled, no known language, too large, or a highlighter that did not load. The text is the fence's
 * own text, so the coloured spans spell exactly what a copy gives.
 */
export function useHighlightedCode(
	text: string | undefined,
	fence: string,
	enabled: boolean,
): ReactNode | undefined {
	const prefs = useCodePrefs()
	const dark = useWindowDark()
	const theme = themeForMode(prefs, dark)
	const [drawn, setDrawn] = useState<Drawn | undefined>()
	useEffect(() => {
		if (!enabled || text === undefined) return
		let current = true
		void blockHighlighter.highlight(text, fence, theme).then((lines) => {
			if (current) setDrawn(lines ? { text, fence, lines } : undefined)
		})
		return () => {
			current = false
		}
	}, [enabled, text, fence, theme])
	// A new theme keeps the old colours until the new ones arrive; only a changed text or fence drops them.
	if (!enabled || !drawn || drawn.text !== text || drawn.fence !== fence) return undefined
	return drawn.lines.map((line, row) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: the lines of a settled block never reorder.
		<span key={row}>
			{line.map((token, at) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: tokens of a line never reorder.
				<span key={at} style={token.color ? { color: token.color } : undefined}>
					{token.content}
				</span>
			))}
			{'\n'}
		</span>
	))
}
