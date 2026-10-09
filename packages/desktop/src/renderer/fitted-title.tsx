import { useLayoutEffect, useRef, useState } from 'react'
import { fitTitle } from './fit-title.js'

/** Width of a text in the font an element uses; undefined where nothing can measure (a test DOM). */
function measurer(element: HTMLElement): ((text: string) => number) | undefined {
	const context = document.createElement('canvas').getContext?.('2d')
	if (!context) return undefined
	const style = getComputedStyle(element)
	context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
	return (text) => context.measureText(text).width
}

/**
 * A title that uses the room its tab or row has: it fills the free width and is cut after a whole
 * word, so it never stops in the middle of a word while space is left. The full text is the tooltip.
 */
export function FittedTitle({
	candidates,
	title,
	fallback,
	className = '',
}: {
	/** The text from most to least informative; the first that fits is shown whole. */
	candidates: readonly string[]
	/** The tooltip; the full title unless given. */
	title?: string
	/** What to show where the room cannot be measured. */
	fallback: string
	className?: string
}) {
	const box = useRef<HTMLSpanElement>(null)
	const [text, setText] = useState(fallback)
	const key = candidates.join('\u0000')
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the candidates' contents.
	useLayoutEffect(() => {
		const element = box.current
		if (!element) return
		const place = () => {
			const measure = measurer(element)
			const room = element.clientWidth
			setText(measure && room > 0 ? fitTitle(candidates, room, measure) : fallback)
		}
		place()
		if (typeof ResizeObserver === 'undefined') return
		const observer = new ResizeObserver(place)
		observer.observe(element)
		return () => observer.disconnect()
	}, [key, fallback])
	return (
		<span
			ref={box}
			className={`fitted-title ${className}`.trim()}
			title={title ?? candidates[0]}
			data-fitted-title
		>
			{text}
		</span>
	)
}
