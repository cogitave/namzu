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

	it('loads tracked and unignored files without offering ignored or unaddressable paths', async () => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-mention-files-'))
		tempDirs.push(root)
		execFileSync('git', ['init', '--quiet'], { cwd: root })
		mkdirSync(join(root, 'src'))
		mkdirSync(join(root, 'ignored'))
		writeFileSync(join(root, '.gitignore'), 'ignored/\n')
		writeFileSync(join(root, 'src', 'app.ts'), 'export {}')
		writeFileSync(join(root, 'space name.ts'), 'not addressable by the current token grammar')
		writeFileSync(join(root, 'ignored', 'secret.ts'), 'ignored')

		const files = await listMentionableFiles(root)

		expect(files).toContain('src/app.ts')
		expect(files).not.toContain('space name.ts')
		expect(files).not.toContain('ignored/secret.ts')
	})
})
