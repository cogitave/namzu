import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { readMentionFile } from './mention-file.js'
import { expandFileMentions } from './mentions.js'

vi.mock('node:fs', async (original) => {
	const actual = await original<typeof import('node:fs')>()
	return {
		...actual,
		readSync: vi.fn(actual.readSync),
		openSync: vi.fn(actual.openSync),
		closeSync: vi.fn(actual.closeSync),
	}
})
const directories: string[] = []
afterEach(() => {
	vi.mocked(fs.readSync).mockRestore()
	vi.mocked(fs.openSync).mockRestore()
	vi.mocked(fs.closeSync).mockClear()
	for (const path of directories.splice(0)) removeTempDir(path)
})
function directory(): string {
	const path = fs.mkdtempSync(join(tmpdir(), 'namzu-mention-bounds-'))
	directories.push(path)
	return path
}

it('reads a huge sparse file with a bounded allocation and bounded byte requests', () => {
	const cwd = directory()
	const path = join(cwd, 'huge.txt')
	fs.writeFileSync(path, '')
	fs.truncateSync(path, 1024 ** 3)
	const budget = { bytes: 16 * 1024 * 1024 }
	const content = readMentionFile(cwd, 'huge.txt', undefined, 60_000, budget)
	expect(content).toHaveLength(60_000 + '\n… (truncated)'.length)
	expect(16 * 1024 * 1024 - budget.bytes).toBeLessThanOrEqual(64 * 1024)
	for (const call of vi.mocked(fs.readSync).mock.calls) {
		expect((call[1] as Buffer).byteLength).toBeLessThanOrEqual(16 * 1024)
	}
	expect(fs.closeSync).toHaveBeenCalled()
})

it('streams to a deep line range without retaining its prefix', () => {
	const cwd = directory()
	fs.writeFileSync(join(cwd, 'lines.txt'), `${'prefix\n'.repeat(20_000)}wanted\nlast`)
	const result = expandFileMentions('@lines.txt#L20001', cwd)
	expect(result.sendText).toContain('lines="20001">\nwanted\n</file>')
	expect(result.sendText).not.toContain('prefix')
})

it('bounds aggregate scanning even when requested line ranges are not reached', () => {
	const cwd = directory()
	for (const name of ['a', 'b', 'c']) {
		fs.writeFileSync(join(cwd, name), '')
		fs.truncateSync(join(cwd, name), 9 * 1024 * 1024)
	}
	const result = expandFileMentions('@a#L2 @b#L2 @c#L2', cwd)
	expect(result.attached).toEqual([])
	expect(fs.openSync).toHaveBeenCalledTimes(2)
	const requested = vi
		.mocked(fs.readSync)
		.mock.calls.reduce((sum, call) => sum + Number((call as readonly unknown[])[3]), 0)
	expect(requested).toBe(16 * 1024 * 1024)
})

it('does not read appended bytes beyond the opened size snapshot', async () => {
	const cwd = directory()
	const path = join(cwd, 'grows.txt')
	fs.writeFileSync(path, 'first\n')
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
	vi.mocked(fs.readSync).mockImplementationOnce((...args) => {
		fs.appendFileSync(path, 'later\n'.repeat(100_000))
		return Reflect.apply(actual.readSync, undefined, args) as number
	})
	const content = readMentionFile(cwd, 'grows.txt', undefined, 60_000, { bytes: 100_000 })
	expect(content).toBe('first\n')
})

it('leaves failed and outside-root paths alone and closes a failed read', () => {
	const cwd = directory()
	fs.writeFileSync(join(cwd, 'file.txt'), 'safe')
	vi.mocked(fs.readSync).mockImplementationOnce(() => {
		throw new Error('file disappeared')
	})
	expect(expandFileMentions('@file.txt @missing @../outside', cwd).attached).toEqual([])
	expect(fs.closeSync).toHaveBeenCalledTimes(1)
})

it('caps attempted files and aggregate attached text before reading later files', () => {
	const reader = vi.fn(() => 'x'.repeat(70_000))
	const text = Array.from({ length: 100 }, (_, i) => `@file${i}`).join(' ')
	const result = expandFileMentions(text, '/unused', reader)
	expect(reader).toHaveBeenCalledTimes(4)
	expect(result.attached).toHaveLength(4)
	const empty = vi.fn(() => '')
	expandFileMentions(text, '/unused', empty)
	expect(empty).toHaveBeenCalledTimes(32)
})
