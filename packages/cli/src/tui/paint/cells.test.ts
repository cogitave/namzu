import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'

import { parseRow, rowWidth, writeRowChange } from './cells.js'

const ESC = '\u001b'

/** What a terminal shows after `before` is on a row and `change` is written over it. */
async function apply(before: string, change: string, cols = 40): Promise<string> {
	const term = new Terminal({ cols, rows: 2, allowProposedApi: true })
	await new Promise<void>((resolve) => term.write(`${before}\r${change}`, resolve))
	return term.buffer.active.getLine(0)?.translateToString(true) ?? ''
}

describe('rows as cells', () => {
	it('reads text, colours and links, and nothing else', () => {
		expect(parseRow('plain')?.length).toBe(5)
		expect(parseRow(`${ESC}[1m${ESC}[38;5;77mhi${ESC}[0m`)?.map((c) => c.sgr)).toEqual([
			`${ESC}[1;38;5;77m`,
			`${ESC}[1;38;5;77m`,
		])
		expect(parseRow(`${ESC}]8;;https://x.test${ESC}\\go${ESC}]8;;${ESC}\\`)?.[0]?.link).not.toBe('')
		expect(parseRow(`a${ESC}[2Kb`)).toBeNull()
		expect(parseRow('a\tb')).toBeNull()
	})

	it('measures wide characters and ignores colour sequences', () => {
		expect(rowWidth(`${ESC}[32m漢字${ESC}[39m ab`)).toBe(7)
	})
})

describe('the write that changes one row into another', () => {
	it('is empty for the same row', () => {
		expect(writeRowChange('same', 'same')).toBe('')
	})

	it('leaves a longer old row clean to its right', async () => {
		const change = writeRowChange('a long old row', 'short')
		expect(await apply('a long old row', change)).toBe('short')
	})

	it('moves the tail when the middle changes width', async () => {
		const before = 'ab漢cd'
		const after = 'abXcd'
		expect(await apply(before, writeRowChange(before, after))).toBe(after)
	})

	it('keeps a link and its colours across a partial change', async () => {
		const row = (word: string) =>
			`${ESC}]8;;https://x.test${ESC}\\${ESC}[32m${word}${ESC}[39m${ESC}]8;;${ESC}\\ tail`
		expect(await apply(row('abcd'), writeRowChange(row('abcd'), row('abXd')))).toBe('abXd tail')
	})

	it('rewrites the whole row when it holds something it cannot cut into cells', async () => {
		const after = `a${ESC}[2Kb`
		expect(writeRowChange('before', after).startsWith('\r')).toBe(true)
	})
})
