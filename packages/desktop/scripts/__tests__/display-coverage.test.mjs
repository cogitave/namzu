// The display face's coverage module must say what the font file says. The ranges are read back out
// of the module's text and compared with a fresh read of the file's character map.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { FONT_FILE, MODULE_FILE } from '../generate-display-coverage.mjs'
import { coveredCodePoints, toRanges } from '../woff2-cmap.mjs'

function moduleRanges() {
	const text = readFileSync(MODULE_FILE, 'utf8')
	const body = /DISPLAY_FACE_RANGES: readonly number\[\] = \[([^\]]*)\]/.exec(text)?.[1] ?? ''
	const numbers = body
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean)
		.map(Number)
	assert.equal(numbers.length % 2, 0, 'the ranges come in pairs')
	const pairs = []
	for (let i = 0; i < numbers.length; i += 2) pairs.push([numbers[i], numbers[i + 1]])
	return pairs
}

test('the coverage module matches the character map of the font file', () => {
	const fresh = toRanges(coveredCodePoints(readFileSync(FONT_FILE)))
	assert.deepEqual(
		moduleRanges(),
		fresh,
		'display-face-coverage.ts is stale: run node scripts/generate-display-coverage.mjs and format it',
	)
})

test('the reader finds the letters the app depends on', () => {
	const covered = new Set(coveredCodePoints(readFileSync(FONT_FILE)))
	for (const char of 'abcxyzABCXYZ0189-_. ç ğ ı İ ş ö ü Ç Ğ Ş Ö Ü'.replace(/ /g, '')) {
		assert.ok(covered.has(char.codePointAt(0)), `${char} is covered`)
	}
	for (const char of 'Ж中😀') assert.ok(!covered.has(char.codePointAt(0)), `${char} is not`)
})
