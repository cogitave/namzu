import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { renderMemoryReport, renderMemorySaveResult } from './presentation.js'
import {
	MEMORY_FILE_MAX_BYTES,
	MEMORY_SECTION_MAX_CHARS,
	appendMemory,
	appendMemoryWithStatus,
	composeMemoryPrompt,
	readMemory,
} from './store.js'

vi.mock('node:fs', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:fs')>()),
}))

let root: string
let home: string
let cwd: string
beforeEach(() => {
	root = fs.mkdtempSync(join(tmpdir(), 'namzu-memory-io-'))
	home = join(root, 'home')
	cwd = join(root, 'checkout')
	fs.mkdirSync(join(home, '.namzu'), { recursive: true })
	fs.mkdirSync(join(cwd, '.git'), { recursive: true })
})
afterEach(() => {
	vi.restoreAllMocks()
	removeTempDir(root)
})

describe('curated memory filesystem admission', () => {
	it.skipIf(process.platform === 'win32').each(['leaf', 'ancestor'] as const)(
		'refuses project memory escaping through a %s symlink on read and append',
		(kind) => {
			const outside = join(root, 'outside')
			fs.mkdirSync(outside)
			const target = join(outside, 'MEMORY.md')
			fs.writeFileSync(target, 'OUTSIDE_CONTENT')
			if (kind === 'ancestor') fs.symlinkSync(outside, join(cwd, '.namzu'), 'dir')
			else {
				fs.mkdirSync(join(cwd, '.namzu'))
				fs.symlinkSync(target, join(cwd, '.namzu', 'MEMORY.md'))
			}
			const content = readMemory(home, cwd)
			expect(content.project).toBeNull()
			expect(renderMemoryReport(content, { home, cwd })).toContain('outside')
			expect(() => appendMemory('must not write', { home, cwd, scope: 'project' })).toThrow(
				/outside/,
			)
			expect(fs.readFileSync(target, 'utf8')).toBe('OUTSIDE_CONTENT')
		},
	)

	it('reports a non-file, invalid UTF-8 and oversized content rather than calling them absent', () => {
		const projectPath = join(cwd, '.namzu', 'MEMORY.md')
		fs.mkdirSync(projectPath, { recursive: true })
		fs.writeFileSync(join(home, '.namzu', 'USER.md'), Buffer.from([0xc3, 0x28]))
		const userPath = join(home, '.namzu', 'MEMORY.md')
		fs.writeFileSync(userPath, 'small prefix')
		fs.truncateSync(userPath, 1024 * 1024 + 1)
		const content = readMemory(home, cwd)
		expect(content.user).toBeNull()
		expect(content.memory).toBeNull()
		expect(content.project).toBeNull()
		const report = renderMemoryReport(content, { home, cwd })
		expect(report).toContain('UTF-8')
		expect(report).toContain('1048576')
		expect(report).toContain('regular file')
		expect(report).not.toContain('No saved memory')
	})
})

describe('memory scope and bounded I/O', () => {
	it.skipIf(process.platform === 'win32').each(['USER.md', 'MEMORY.md'])(
		'refuses user %s pointing outside the application home',
		(file) => {
			const outside = join(root, 'outside.md')
			fs.writeFileSync(outside, 'PRIVATE_OUTSIDE')
			fs.symlinkSync(outside, join(home, '.namzu', file))
			const content = readMemory(home, cwd)
			expect(content.diagnostics?.[0]?.reason).toContain('outside')
			expect(composeMemoryPrompt(content)).toBeNull()
			if (file === 'MEMORY.md') expect(() => appendMemory('no write', home)).toThrow(/outside/)
			expect(fs.readFileSync(outside, 'utf8')).toBe('PRIVATE_OUTSIDE')
		},
	)

	it.skipIf(process.platform === 'win32')('rejects a redirected application-home root', () => {
		const outside = join(root, 'outside')
		fs.mkdirSync(outside)
		fs.writeFileSync(join(outside, 'MEMORY.md'), 'OUTSIDE')
		fs.rmdirSync(join(home, '.namzu'))
		fs.symlinkSync(outside, join(home, '.namzu'), 'dir')
		expect(readMemory(home).diagnostics).toHaveLength(2)
		expect(() => appendMemory('no write', home)).toThrow(/scope root.*symlink/)
		expect(fs.readFileSync(join(outside, 'MEMORY.md'), 'utf8')).toBe('OUTSIDE')
	})

	it.skipIf(process.platform === 'win32').each(['leaf', 'ancestor'] as const)(
		'permits an intentional in-project %s symlink for reads and appends',
		(kind) => {
			const inside = join(cwd, 'notes')
			fs.mkdirSync(inside)
			const target = join(inside, 'MEMORY.md')
			fs.writeFileSync(target, '- existing\n')
			if (kind === 'ancestor') fs.symlinkSync(inside, join(cwd, '.namzu'), 'dir')
			else {
				fs.mkdirSync(join(cwd, '.namzu'))
				fs.symlinkSync(target, join(cwd, '.namzu', 'MEMORY.md'))
			}
			expect(readMemory(home, cwd).project).toBe('- existing')
			appendMemory('new', { scope: 'project', cwd, home })
			expect(fs.readFileSync(target, 'utf8')).toBe('- existing\n- new\n')
		},
	)

	it.skipIf(process.platform === 'win32')(
		'diagnoses a broken ancestor without falling back to checkout memory',
		() => {
			appendMemory('root fact', { scope: 'project', cwd, home })
			const nested = join(cwd, 'pkg')
			fs.mkdirSync(nested)
			fs.symlinkSync(join(cwd, 'missing'), join(nested, '.namzu'), 'dir')
			const content = readMemory(home, nested)
			expect(content.project).toBeNull()
			expect(content.diagnostics?.[0]).toEqual({
				path: join(nested, '.namzu', 'MEMORY.md'),
				reason: 'Memory path contains a broken symlink.',
			})
			expect(() => appendMemory('no write', { scope: 'project', cwd: nested, home })).toThrow(
				/broken symlink/,
			)
		},
	)

	it.each(['invalid', 'oversized'] as const)(
		'refuses appending to %s existing content without replacing it',
		(kind) => {
			const path = join(home, '.namzu', 'MEMORY.md')
			const original =
				kind === 'invalid'
					? Buffer.from([0xc3, 0x28])
					: Buffer.alloc(MEMORY_FILE_MAX_BYTES + 1, 'a')
			fs.writeFileSync(path, original)
			expect(() => appendMemory('no write', home)).toThrow(
				kind === 'invalid' ? /UTF-8/ : /file limit/,
			)
			expect(fs.readFileSync(path).equals(original)).toBe(true)
		},
	)

	it('refuses oversized files before reading their content', () => {
		const path = join(home, '.namzu', 'MEMORY.md')
		fs.writeFileSync(path, '')
		fs.truncateSync(path, MEMORY_FILE_MAX_BYTES + 1)
		const read = vi.spyOn(fs, 'readSync')
		expect(readMemory(home).diagnostics?.[0]?.reason).toContain('file limit')
		expect(read).not.toHaveBeenCalled()
	})

	it('bounds bytes read even when a file grows after the initial stat', () => {
		const path = join(home, '.namzu', 'MEMORY.md')
		fs.writeFileSync(path, 'initial')
		const actualRead = fs.readSync
		let total = 0
		let first = true
		vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
			if (first) {
				first = false
				fs.appendFileSync(path, Buffer.alloc(MEMORY_FILE_MAX_BYTES + 500, 'a'))
			}
			const count = actualRead(...args)
			total += count
			return count
		}) as typeof fs.readSync)
		expect(readMemory(home).memory).toBeNull()
		expect(total).toBe(MEMORY_FILE_MAX_BYTES + 1)
	})

	it('reports unreadable content separately from an absent file', () => {
		const path = join(home, '.namzu', 'MEMORY.md')
		fs.writeFileSync(path, 'intact')
		vi.spyOn(fs, 'readSync').mockImplementation(() => {
			throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
		})
		const content = readMemory(home)
		expect(content.memory).toBeNull()
		expect(content.diagnostics).toEqual([{ path, reason: 'permission denied' }])
		expect(() => appendMemory('no write', home)).toThrow(/permission denied/)
		expect(fs.readFileSync(path, 'utf8')).toBe('intact')
	})
})

describe('append prompt inclusion', () => {
	it.each([0, MEMORY_SECTION_MAX_CHARS - 5, MEMORY_SECTION_MAX_CHARS + 10])(
		'reports whether a new note fits after %i existing characters',
		(length) => {
			const path = join(home, '.namzu', 'MEMORY.md')
			fs.writeFileSync(path, 'x'.repeat(length))
			const result = appendMemoryWithStatus('NEW_NOTE', home)
			expect(result.appended).toBe(true)
			expect(result.includedInPrompt).toBe(length === 0)
			expect(fs.readFileSync(path, 'utf8')).toContain('NEW_NOTE')
			const report = renderMemorySaveResult(result, 'NEW_NOTE')
			if (length > 0) {
				expect(report).toContain('not be fully included')
				expect(report).toContain('8,000')
				expect(report).toContain(path)
				expect(report).not.toContain('Remembered')
			} else expect(report).toContain('Remembered')
		},
	)

	it('does not split supplementary characters at the prompt boundary', () => {
		const prompt = composeMemoryPrompt({
			user: null,
			memory: null,
			project: `${'x'.repeat(MEMORY_SECTION_MAX_CHARS - 1)}😀tail`,
		})
		expect(prompt).not.toContain('\ud83d')
		expect(prompt).toContain('6 more characters')
	})
})
