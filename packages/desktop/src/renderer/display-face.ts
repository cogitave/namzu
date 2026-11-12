import { DISPLAY_FACE_RANGES } from './display-face-coverage.js'

/**
 * The display voice: a pixel face for a few large words, never a sentence, never text a person or
 * a model wrote, never small. The one name of a person's own it may draw is a project folder's, and a
 * folder can be named with any characters, so a name is drawn in the display face only when every
 * one of its characters is in that face; otherwise the whole name stays in the interface face, never
 * a mix inside one name. The covered code points are read from the font file itself
 * (`scripts/generate-display-coverage.mjs` writes `display-face-coverage.ts`).
 */

const covered = (() => {
	const ranges: [number, number][] = []
	for (let i = 0; i + 1 < DISPLAY_FACE_RANGES.length; i += 2) {
		ranges.push([DISPLAY_FACE_RANGES[i] as number, DISPLAY_FACE_RANGES[i + 1] as number])
	}
	return ranges
})()

function hasCodePoint(point: number): boolean {
	let low = 0
	let high = covered.length - 1
	while (low <= high) {
		const middle = (low + high) >> 1
		const [first, last] = covered[middle] as [number, number]
		if (point < first) high = middle - 1
		else if (point > last) low = middle + 1
		else return true
	}
	return false
}

/**
 * The text to draw in the display face, or `undefined` when it must stay in the interface face.
 * Composed (NFC) form is judged and returned: a folder name that arrives as a base letter plus a
 * combining mark is the same text, and the face draws the composed letter when it has one.
 */
export function displayFaceText(name: string): string | undefined {
	const text = name.normalize('NFC')
	if (text.length === 0) return undefined
	for (const char of text) {
		if (!hasCodePoint(char.codePointAt(0) as number)) return undefined
	}
	return text
}

/** Whether a whole name can be drawn in the display face. */
export function displayFaceCovers(name: string): boolean {
	return displayFaceText(name) !== undefined
}
