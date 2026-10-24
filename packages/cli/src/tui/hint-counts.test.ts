import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { hintCountsPath, readHintCount, writeHintCount } from './hint-counts.js'

describe('hint counts', () => {
	it('read as zero until written, then survive a second reader', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-hints-'))
		expect(readHintCount('queuedMessagesHint', home)).toBe(0)
		writeHintCount('queuedMessagesHint', 2, home)
		expect(readHintCount('queuedMessagesHint', home)).toBe(2)
	})

	it('read a damaged file as zero instead of failing', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-hints-'))
		writeHintCount('other', 1, home)
		writeFileSync(hintCountsPath(home), '{not json')
		expect(readHintCount('other', home)).toBe(0)
	})
})
