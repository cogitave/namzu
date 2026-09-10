import { describe, expect, it } from 'vitest'
import { fileWriteResult } from '../file-write-result.js'

describe('file write receipts', () => {
	it('distinguishes a new empty file from an unchanged existing empty file', () => {
		expect(fileWriteResult('a', undefined, '').data).toMatchObject({
			fileChange: { operation: 'create', added: 0, removed: 0 },
		})
		expect(fileWriteResult('a', '', '').data).toMatchObject({
			fileChange: { operation: 'unchanged' },
		})
	})
	it('counts UTF-8 bytes separately from the legacy character size', () => {
		expect(fileWriteResult('a', undefined, 'ş\n').data).toMatchObject({
			size: 2,
			fileChange: {
				bytes: 3,
				added: 1,
				removed: 0,
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		})
	})
	it('preserves real trailing blank lines without counting the terminator', () => {
		expect(fileWriteResult('a', undefined, 'one\n\n').output).toContain('(+2 -0)')
	})
	it('reports the changed region rather than unchanged prefix and suffix', () => {
		expect(
			fileWriteResult('a', 'name=Namzu\nmode=old\nkeep=yes\n', 'name=Namzu\nmode=new\nkeep=yes\n')
				.output,
		).toContain('Updated a (+1 -1)')
	})
	it('does not hide a final-newline-only change', () => {
		expect(fileWriteResult('a', 'one', 'one\n').output).toContain('final newline changed')
		expect(fileWriteResult('a', 'one', 'one\n').data).toMatchObject({
			fileChange: { operation: 'replace', newlineChanged: true },
		})
	})
	it('does not claim creation or a diff when prior state is unknown', () => {
		const result = fileWriteResult('a', null, 'one\n', true)
		expect(result.output).toBe('Wrote a · 4 bytes')
		expect(result.data).toMatchObject({
			sandboxed: true,
			fileChange: { operation: 'write' },
		})
		expect((result.data as { fileChange: object }).fileChange).not.toHaveProperty('added')
	})
})
