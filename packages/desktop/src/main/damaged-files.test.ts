import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	DamagedFileError,
	DamagedFilesNotices,
	parseJsonShape,
	readStoredFile,
	setAsideDamaged,
} from './damaged-files.js'

let directory: string
let file: string
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'namzu-damaged-'))
	file = join(directory, 'projects.json')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

const asArray = (text: string) => parseJsonShape(text, 'array')

describe('readStoredFile', () => {
	it('reads a good file and leaves it where it is', () => {
		writeFileSync(file, '["/a"]')
		expect(readStoredFile({ file, parse: asArray })).toEqual(['/a'])
		expect(existsSync(`${file}.bad`)).toBe(false)
	})

	it('treats a missing file as a first run: no callback, nothing created', () => {
		const onDamaged = vi.fn()
		const onUnreadable = vi.fn()
		expect(readStoredFile({ file, parse: asArray, onDamaged, onUnreadable })).toBeUndefined()
		expect(onDamaged).not.toHaveBeenCalled()
		expect(onUnreadable).not.toHaveBeenCalled()
	})

	it.each([
		['not JSON', '{"a":'],
		['the wrong shape', '{"a":1}'],
	])('moves a file that is %s aside as .bad and keeps its bytes', (_name, text) => {
		writeFileSync(file, text)
		const onDamaged = vi.fn()
		expect(readStoredFile({ file, parse: asArray, onDamaged })).toBeUndefined()
		expect(onDamaged).toHaveBeenCalledWith(true)
		expect(existsSync(file)).toBe(false)
		expect(readFileSync(`${file}.bad`, 'utf8')).toBe(text)
	})

	it('replaces an older .bad with the newest damage', () => {
		writeFileSync(`${file}.bad`, 'old')
		writeFileSync(file, '{')
		readStoredFile({ file, parse: asArray })
		expect(readFileSync(`${file}.bad`, 'utf8')).toBe('{')
	})

	it('does not touch a file it cannot open', () => {
		const onDamaged = vi.fn()
		const onUnreadable = vi.fn()
		const error = Object.assign(new Error('no'), { code: 'EACCES' })
		const rename = vi.fn()
		readStoredFile({
			file,
			parse: asArray,
			onDamaged,
			onUnreadable,
			ops: {
				read: () => {
					throw error
				},
				rename,
			},
		})
		expect(onUnreadable).toHaveBeenCalledWith(error)
		expect(onDamaged).not.toHaveBeenCalled()
		expect(rename).not.toHaveBeenCalled()
	})

	it('reports when the file could not be moved aside', () => {
		const onDamaged = vi.fn()
		readStoredFile({
			file,
			parse: () => {
				throw new DamagedFileError('x')
			},
			onDamaged,
			ops: {
				read: () => 'x',
				rename: () => {
					throw new Error('locked')
				},
			},
		})
		expect(onDamaged).toHaveBeenCalledWith(false)
	})

	it('lets a bug in the parser through rather than moving a good file', () => {
		writeFileSync(file, '[]')
		expect(() =>
			readStoredFile({
				file,
				parse: () => {
					throw new TypeError('bug')
				},
			}),
		).toThrow('bug')
		expect(existsSync(file)).toBe(true)
	})
})

describe('parseJsonShape', () => {
	it('refuses an oversized, null or mismatched document', () => {
		expect(() => parseJsonShape('{}', 'object', 1)).toThrow(DamagedFileError)
		expect(() => parseJsonShape('null', 'object')).toThrow(DamagedFileError)
		expect(() => parseJsonShape('[]', 'object')).toThrow(DamagedFileError)
		expect(parseJsonShape('{}', 'object')).toEqual({})
	})
})

describe('setAsideDamaged', () => {
	it('is false when the move fails', () => {
		expect(
			setAsideDamaged(file, {
				rename: () => {
					throw new Error('no')
				},
			}),
		).toBe(false)
	})
})

describe('DamagedFilesNotices', () => {
	it('has nothing to say until a file was set aside', () => {
		expect(new DamagedFilesNotices(() => 'a').current()).toBeUndefined()
	})

	it('says it once in plain words and offers the same id until acknowledged', () => {
		const notices = new DamagedFilesNotices(() => 'id-1')
		notices.add('settings', true)
		const notice = notices.current()
		expect(notice).toEqual({
			id: 'id-1',
			text: 'Namzu could not read your saved settings, so it started with the default. The damaged file was set aside, not deleted.',
		})
		expect(notices.current()).toEqual(notice)
		expect(notices.acknowledge('other')).toBe(false)
		expect(notices.current()).toEqual(notice)
		expect(notices.acknowledge('id-1')).toBe(true)
		expect(notices.current()).toBeUndefined()
	})

	it('names several files in one sentence, and says so when one could not be moved', () => {
		let count = 0
		const notices = new DamagedFilesNotices(() => `id-${++count}`)
		notices.add('projects', true)
		notices.add('layout', true)
		notices.add('settings', true)
		expect(notices.current()?.text).toBe(
			'Namzu could not read your saved settings, window layout and project list, so it started with the defaults. The damaged files were set aside, not deleted.',
		)
		notices.add('layout', false)
		expect(notices.current()?.text).toContain('could not move the damaged file aside')
		expect(notices.current()?.id).toBe('id-2')
	})
})
