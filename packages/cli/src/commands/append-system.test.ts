import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { MAX_APPEND_SYSTEM_CHARS, resolveAppendSystemPrompt } from './append-system.js'

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-append-system-unit-'))
})
afterEach(() => removeTempDir(dir))

describe('resolveAppendSystemPrompt', () => {
	it('is nothing when the flag was not given', () => {
		expect(resolveAppendSystemPrompt(null)).toBeUndefined()
	})

	it('takes the value as the text, trimmed', () => {
		expect(resolveAppendSystemPrompt('  Be brief.  ')).toEqual({ text: 'Be brief.' })
	})

	it('reads a file named with @, relative to the base directory', () => {
		writeFileSync(join(dir, 'p.md'), 'From the file.\n')
		expect(resolveAppendSystemPrompt('@p.md', dir)).toEqual({ text: 'From the file.' })
	})

	it.each([
		['a bare @', '@'],
		['a file that is not there', '@missing.md'],
		['a folder', '@sub'],
		['an empty value', '   '],
	])('refuses %s, naming the flag', (_name, value) => {
		mkdirSync(join(dir, 'sub'))
		const result = resolveAppendSystemPrompt(value, dir)
		expect(result).toMatchObject({ error: expect.stringContaining('--append-system-prompt') })
	})

	it('refuses text longer than the limit and says by how much it is over', () => {
		const result = resolveAppendSystemPrompt('x'.repeat(MAX_APPEND_SYSTEM_CHARS + 1))
		expect(result).toMatchObject({ error: expect.stringContaining('100,001 characters') })
	})
})
