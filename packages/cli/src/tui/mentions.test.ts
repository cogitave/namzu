import { describe, expect, it } from 'vitest'

import { expandFileMentions } from './mentions.js'

const fake = (files: Record<string, string>) => (rel: string) => files[rel] ?? null

describe('expandFileMentions', () => {
	it('inlines a mentioned file and reports it', () => {
		const { sendText, attached } = expandFileMentions(
			'fix @src/auth.ts please',
			'/repo',
			fake({ 'src/auth.ts': 'export const x = 1' }),
		)
		expect(attached).toEqual(['src/auth.ts'])
		expect(sendText).toContain('fix @src/auth.ts please')
		expect(sendText).toContain('<file path="src/auth.ts">\nexport const x = 1\n</file>')
	})

	it('leaves text untouched when there are no mentions', () => {
		const r = expandFileMentions('no mentions here', '/repo', fake({}))
		expect(r).toEqual({ sendText: 'no mentions here', attached: [] })
	})

	it('ignores tokens that do not resolve to a readable file', () => {
		const r = expandFileMentions('@missing.ts', '/repo', fake({}))
		expect(r.attached).toEqual([])
		expect(r.sendText).toBe('@missing.ts')
	})

	it('de-duplicates repeated mentions', () => {
		const { attached } = expandFileMentions('@a.ts and again @a.ts', '/repo', fake({ 'a.ts': 'x' }))
		expect(attached).toEqual(['a.ts'])
	})

	it('does not swallow trailing punctuation into the path', () => {
		const { attached } = expandFileMentions(
			'see @a.ts, @b.ts.',
			'/repo',
			fake({ 'a.ts': '1', 'b.ts': '2' }),
		)
		expect(attached).toEqual(['a.ts', 'b.ts'])
	})

	it('inlines multiple distinct files', () => {
		const { attached, sendText } = expandFileMentions(
			'@a.ts @b.ts',
			'/repo',
			fake({ 'a.ts': 'A', 'b.ts': 'B' }),
		)
		expect(attached).toEqual(['a.ts', 'b.ts'])
		expect(sendText).toContain('<file path="a.ts">')
		expect(sendText).toContain('<file path="b.ts">')
	})
})
