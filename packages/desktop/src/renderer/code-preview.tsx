import { getSharedHighlighter } from '@pierre/diffs'
import { useEffect, useState } from 'react'
import { type CodeThemeKey, codeThemeIds } from '../shared/code-themes.js'

/** A few lines that show comments, strings, numbers, keywords and calls in the colours of a set. */
export const CODE_SAMPLE = `// Add up what each file changed
export function total(files: File[]): number {
  let lines = 0
  for (const file of files) {
    if (!file.path.endsWith('.md')) lines += file.added + 1
  }
  return lines
}
`

const LANGUAGE = 'typescript'

/**
 * A sample of code in one colour set, drawn with the same highlighter as diffs and file views. The
 * card keeps the set's own background, so the light choice reads as light also in a dark window.
 */
export function CodePreview({ mode, value }: { mode: 'light' | 'dark'; value: CodeThemeKey }) {
	const ids = codeThemeIds(value, value)
	const theme = mode === 'light' ? ids.light : ids.dark
	const [drawn, setDrawn] = useState<ThemedTokens | undefined>()
	useEffect(() => {
		let current = true
		getSharedHighlighter({
			themes: [theme],
			langs: [LANGUAGE],
			preferredHighlighter: 'shiki-wasm',
		}).then(
			(highlighter) => {
				if (!current) return
				const { tokens, bg, fg } = highlighter.codeToTokens(CODE_SAMPLE, { lang: LANGUAGE, theme })
				setDrawn({ lines: tokens, bg, fg })
			},
			// A highlighter that cannot load leaves the sample as plain text.
			() => current && setDrawn(undefined),
		)
		return () => {
			current = false
		}
	}, [theme])
	return (
		<div
			className="settings-code-preview"
			data-mode={mode}
			data-theme-id={theme}
			role="img"
			aria-label={`Sample of code in the ${mode} colours`}
		>
			{drawn ? (
				<pre style={{ background: drawn.bg, color: drawn.fg }}>
					{drawn.lines.map((line, row) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: the sample's lines never reorder.
						<div key={row}>
							{line.length === 0 ? '\u200b' : null}
							{line.map((token) => (
								<span key={token.offset} style={{ color: token.color }}>
									{token.content}
								</span>
							))}
						</div>
					))}
				</pre>
			) : (
				<pre>{CODE_SAMPLE}</pre>
			)}
		</div>
	)
}

interface ThemedTokens {
	lines: { content: string; color?: string; offset: number }[][]
	bg?: string
	fg?: string
}
