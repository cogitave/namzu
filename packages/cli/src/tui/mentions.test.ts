import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	activeFileMention,
	expandFileMentions,
	listMentionableFiles,
	matchMentionableFiles,
	mentionText,
} from './mentions.js'

const fake = (files: Record<string, string>) => (rel: string) => files[rel] ?? null
const tempDirs: string[] = []

afterEach(() => {
	for (const path of tempDirs.splice(0)) removeTempDir(path)
})

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

	it('does not follow a project symlink to a file outside the trusted root', () => {
		const base = mkdtempSync(join(tmpdir(), 'namzu-mention-link-'))
		tempDirs.push(base)
		const root = join(base, 'project')
		mkdirSync(root)
		const outside = join(base, 'outside.txt')
		writeFileSync(outside, 'secret outside bytes')
		symlinkSync(outside, join(root, 'linked.txt'))

		const result = expandFileMentions('read @linked.txt', root)

		expect(result).toEqual({ sendText: 'read @linked.txt', attached: [] })
	})
})

describe('richer mentions', () => {
	const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')

	it('reads a quoted path with spaces', () => {
		const { attached, sendText } = expandFileMentions(
			'see @"my docs/a b.ts" now',
			'/repo',
			fake({ 'my docs/a b.ts': 'spaced' }),
		)
		expect(attached).toEqual(['my docs/a b.ts'])
		expect(sendText).toContain('<file path="my docs/a b.ts">\nspaced\n</file>')
	})

	it('reads a unicode path', () => {
		const { attached } = expandFileMentions(
			'bak @belgeler/özet.md',
			'/repo',
			fake({ 'belgeler/özet.md': 'x' }),
		)
		expect(attached).toEqual(['belgeler/özet.md'])
	})

	it('sends only the lines of an #L10-20 range, inclusive', () => {
		const { attached, sendText } = expandFileMentions(
			'@a.ts#L10-12 please',
			'/repo',
			fake({ 'a.ts': lines }),
		)
		expect(attached).toEqual(['a.ts#L10-12'])
		expect(sendText).toContain(
			'<file path="a.ts" lines="10-12">\nline 10\nline 11\nline 12\n</file>',
		)
		expect(sendText).not.toContain('line 9')
		expect(sendText).not.toContain('line 13')
	})

	it('sends one line for #L7', () => {
		const { sendText } = expandFileMentions('@a.ts#L7', '/repo', fake({ 'a.ts': lines }))
		expect(sendText).toContain('<file path="a.ts" lines="7">\nline 7\n</file>')
	})

	it('reads a range that starts beyond what the old cap could hold', () => {
		const big = Array.from({ length: 20_000 }, (_, i) => `row ${i + 1}`).join('\n')
		const { sendText } = expandFileMentions(
			'@big.ts#L19999-20000',
			'/repo',
			fake({ 'big.ts': big }),
		)
		expect(sendText).toContain('row 19999\nrow 20000')
	})

	it('keeps the whole file for a different range of the same path as its own mention', () => {
		const { attached } = expandFileMentions(
			'@a.ts#L1-2 @a.ts#L3-4 @a.ts',
			'/repo',
			fake({ 'a.ts': lines }),
		)
		expect(attached).toEqual(['a.ts#L1-2', 'a.ts#L3-4', 'a.ts'])
	})

	it('does not take a closing bracket of the sentence into the path', () => {
		const { attached } = expandFileMentions(
			'(see @a.ts) and [@b.ts]',
			'/repo',
			fake({ 'a.ts': '1', 'b.ts': '2' }),
		)
		expect(attached).toEqual(['a.ts', 'b.ts'])
	})

	it('still caps one file at 60 000 characters', () => {
		const { sendText } = expandFileMentions('@a.ts', '/repo', fake({ 'a.ts': 'x'.repeat(70_000) }))
		expect(sendText).toContain('… (truncated)')
	})
})

describe('file mention completion', () => {
	it('finds only the token ending at the cursor and leaves email-like text alone', () => {
		expect(activeFileMention('fix @src/auth', 13)).toEqual({
			start: 4,
			end: 13,
			query: 'src/auth',
		})
		expect(activeFileMention('mail a@b.test', 13)).toBeNull()
		expect(activeFileMention('@old.ts then text', 17)).toBeNull()
	})

	it('ranks basename prefixes before path and subsequence matches', () => {
		expect(
			matchMentionableFiles('app', [
				'src/mapped.ts',
				'app/config.ts',
				'src/app.ts',
				'src/api-proxy.ts',
			]),
		).toEqual(['src/app.ts', 'app/config.ts', 'src/mapped.ts', 'src/api-proxy.ts'])
	})

	it('completes a quoted token that holds spaces, without the quote in the query', () => {
		expect(activeFileMention('read @"my fi', 12)).toEqual({ start: 5, end: 12, query: 'my fi' })
		expect(activeFileMention('read @"done.ts" then', 20)).toBeNull()
	})

	it('completes names in any script', () => {
		expect(activeFileMention('bak @belgeler/özet', 18)).toMatchObject({ query: 'belgeler/özet' })
		expect(activeFileMention('bak a_é@x', 9)).toBeNull()
	})

	it('writes a quoted mention when the path cannot stand bare', () => {
		expect(mentionText('src/a.ts')).toBe('@src/a.ts')
		expect(mentionText('my docs/a b.ts')).toBe('@"my docs/a b.ts"')
		expect(mentionText('a+b.ts')).toBe('@"a+b.ts"')
	})

	it('loads tracked and unignored files without offering ignored or unaddressable paths', async () => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-mention-files-'))
		tempDirs.push(root)
		execFileSync('git', ['init', '--quiet'], { cwd: root })
		mkdirSync(join(root, 'src'))
		mkdirSync(join(root, 'ignored'))
		writeFileSync(join(root, '.gitignore'), 'ignored/\n')
		writeFileSync(join(root, 'src', 'app.ts'), 'export {}')
		writeFileSync(join(root, 'space name.ts'), 'addressable as a quoted mention')
		writeFileSync(join(root, 'özet.md'), 'unicode name')
		writeFileSync(join(root, 'ignored', 'secret.ts'), 'ignored')

		const files = await listMentionableFiles(root)

		expect(files).toContain('src/app.ts')
		expect(files).toContain('space name.ts')
		expect(files).toContain('özet.md')
		expect(files).not.toContain('ignored/secret.ts')
	})
})
