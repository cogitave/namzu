/**
 * The frame counter behind the animated busy glyph in the terminal title.
 * Advances every `TITLE_ANIMATION_MS` while `active`; when it stops the count
 * stays where it was, so the title freezes on the frame it showed.
 */

import { useEffect, useState } from 'react'

import { TITLE_ANIMATION_MS } from './terminal-title.js'

export function useTitleFrame(active: boolean): number {
	const [frame, setFrame] = useState(0)
	useEffect(() => {
		if (!active) return
		const timer = setInterval(() => setFrame((current) => current + 1), TITLE_ANIMATION_MS)
		return () => clearInterval(timer)
	}, [active])
	return frame
}
