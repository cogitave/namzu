/**
 * The watcher for `file_changed`: one event for a burst, `add` / `change` /
 * `unlink` from what is on disk, the path limit, and a watch that fails.
 * The clock and the platform's watch are faked; one test uses the real
 * `fs.watch` and waits for the real event.
 */

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	FILE_SETTLE_MS,
	type FileChange,
	FileChangeWatcher,
	MAX_WATCHED_PATHS,
	type WatchDirectory,
} from '../file-change-watch.js'

function harness(initial: string[] = []) {
	const present = new Set(initial)
	const listeners = new Map<string, (name: string | null) => void>()
	const closed: string[] = []
	const errors = new Map<string, (error: Error) => void>()
	const changes: FileChange[] = []
	const problems: string[] = []
	let failFor: string | undefined
	const watchDirectory: WatchDirectory = (directory, listener, onError) => {
		if (directory === failFor) throw new Error('ENOENT: no such folder')
		listeners.set(directory, listener)
		errors.set(directory, onError)
		return { close: () => closed.push(directory) }
	}
	const watcher = new FileChangeWatcher({
		onChange: (change) => changes.push(change),
		onProblem: (message) => problems.push(message),
		watchDirectory,
		exists: (path) => present.has(path),
	})
	return {
		watcher,
		present,
		listeners,
		closed,
		errors,
		changes,
		problems,
		failFor: (directory: string) => {
			failFor = directory
		},
	}
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('settling', () => {
	it('reports a burst of writes to one file as one change, after it has been still', () => {
		const h = harness(['/p/a.txt'])
		h.watcher.setPaths(['a.txt'], '/p')
		const touch = h.listeners.get('/p') as (name: string) => void
		for (let i = 0; i < 5; i++) {
			touch('a.txt')
			vi.advanceTimersByTime(FILE_SETTLE_MS - 100)
		}
		expect(h.changes).toEqual([])
		vi.advanceTimersByTime(100)
		expect(h.changes).toEqual([{ path: '/p/a.txt', change: 'change' }])
	})

	it('reports the next change as a new event', () => {
		const h = harness(['/p/a.txt'])
		h.watcher.setPaths(['/p/a.txt'], '/')
		const touch = h.listeners.get('/p') as (name: string) => void
		touch('a.txt')
		vi.advanceTimersByTime(FILE_SETTLE_MS)
		touch('a.txt')
		vi.advanceTimersByTime(FILE_SETTLE_MS)
		expect(h.changes).toHaveLength(2)
	})

	it('says add for a file that appears, unlink for one that goes, and nothing for neither', () => {
		const h = harness()
		h.watcher.setPaths(['.envrc'], '/p')
		const touch = h.listeners.get('/p') as (name: string) => void
		touch('.envrc')
		vi.advanceTimersByTime(FILE_SETTLE_MS)
		expect(h.changes).toEqual([])
		h.present.add('/p/.envrc')
		touch('.envrc')
		vi.advanceTimersByTime(FILE_SETTLE_MS)
		h.present.delete('/p/.envrc')
		touch('.envrc')
		vi.advanceTimersByTime(FILE_SETTLE_MS)
		expect(h.changes.map((c) => c.change)).toEqual(['add', 'unlink'])
	})

	it('ignores other files in a watched folder', () => {
		const h = harness(['/p/a.txt', '/p/b.txt'])
		h.watcher.setPaths(['a.txt'], '/p')
		;(h.listeners.get('/p') as (name: string) => void)('b.txt')
		vi.advanceTimersByTime(FILE_SETTLE_MS * 2)
		expect(h.changes).toEqual([])
	})

	it('looks at every watched file in the folder when the platform names none', () => {
		const h = harness(['/p/a.txt', '/p/b.txt'])
		h.watcher.setPaths(['a.txt', 'b.txt'], '/p')
		;(h.listeners.get('/p') as (name: string | null) => void)(null)
		vi.advanceTimersByTime(FILE_SETTLE_MS)
		expect(h.changes.map((c) => c.path).sort()).toEqual(['/p/a.txt', '/p/b.txt'])
	})
})

describe('what is watched', () => {
	it('watches nothing, and starts no watch, until a path is given', () => {
		const h = harness()
		expect(h.watcher.watching).toEqual([])
		expect(h.listeners.size).toBe(0)
	})

	it('shares one watch among the files of a folder and lets go of a folder no longer named', () => {
		const h = harness()
		h.watcher.setPaths(['/p/a', '/p/b', '/q/c'], '/')
		expect([...h.listeners.keys()].sort()).toEqual(['/p', '/q'])
		h.watcher.setPaths(['/p/a'], '/')
		expect(h.closed).toEqual(['/q'])
		h.watcher.setPaths([], '/')
		expect(h.closed.sort()).toEqual(['/p', '/q'])
		expect(h.watcher.watching).toEqual([])
	})

	it('drops a pending event for a file that is no longer watched', () => {
		const h = harness(['/p/a'])
		h.watcher.setPaths(['/p/a'], '/')
		;(h.listeners.get('/p') as (name: string) => void)('a')
		h.watcher.setPaths([], '/')
		vi.advanceTimersByTime(FILE_SETTLE_MS * 2)
		expect(h.changes).toEqual([])
	})

	it('cuts a list past the limit and says so once', () => {
		const h = harness()
		const paths = Array.from({ length: MAX_WATCHED_PATHS + 10 }, (_, i) => `/p/f${i}`)
		h.watcher.setPaths(paths, '/')
		h.watcher.setPaths(paths, '/')
		expect(h.watcher.watching).toHaveLength(MAX_WATCHED_PATHS)
		expect(h.watcher.watching[0]).toBe('/p/f0')
		expect(h.problems).toHaveLength(1)
		expect(h.problems[0]).toMatch(/only the first 64/)
	})

	it('reports a watch that cannot start once, and watches the other folders', () => {
		const h = harness()
		h.failFor('/gone')
		h.watcher.setPaths(['/gone/a', '/p/b'], '/')
		h.watcher.setPaths(['/gone/a', '/p/b'], '/')
		expect(h.problems).toHaveLength(1)
		expect(h.problems[0]).toMatch(/\/gone cannot be watched/)
		expect(h.listeners.has('/p')).toBe(true)
	})

	it('reports a watch that breaks later, once, and goes on with the rest', () => {
		const h = harness(['/p/a', '/q/b'])
		h.watcher.setPaths(['/p/a', '/q/b'], '/')
		;(h.errors.get('/p') as (error: Error) => void)(new Error('EMFILE'))
		expect(h.problems).toHaveLength(1)
		;(h.listeners.get('/q') as (name: string) => void)('b')
		vi.advanceTimersByTime(FILE_SETTLE_MS)
		expect(h.changes).toEqual([{ path: '/q/b', change: 'change' }])
	})

	it('stops everything when closed', () => {
		const h = harness(['/p/a'])
		h.watcher.setPaths(['/p/a'], '/')
		;(h.listeners.get('/p') as (name: string) => void)('a')
		h.watcher.close()
		vi.advanceTimersByTime(FILE_SETTLE_MS * 2)
		expect(h.changes).toEqual([])
		expect(h.closed).toEqual(['/p'])
		h.watcher.setPaths(['/p/a'], '/')
		expect(h.watcher.watching).toEqual([])
	})
})

describe('the platform watch', () => {
	// Real folder, real fs.watch, real settling (kept short): the event is
	// awaited, never raced against a timer.
	it('reports a real write, a real removal and a real re-creation', async () => {
		vi.useRealTimers()
		const dir = mkdtempSync(join(tmpdir(), 'namzu-file-watch-'))
		const file = join(dir, '.envrc')
		writeFileSync(file, 'one')
		const next = () =>
			new Promise<FileChange>((resolve) => {
				pending = resolve
			})
		let pending: (change: FileChange) => void = () => {}
		const watcher = new FileChangeWatcher({ onChange: (change) => pending(change), settleMs: 50 })
		try {
			watcher.setPaths([file], dir)
			let seen = next()
			writeFileSync(file, 'two')
			writeFileSync(file, 'three')
			expect(await seen).toEqual({ path: file, change: 'change' })
			seen = next()
			unlinkSync(file)
			expect(await seen).toEqual({ path: file, change: 'unlink' })
			seen = next()
			writeFileSync(file, 'back')
			expect(await seen).toEqual({ path: file, change: 'add' })
		} finally {
			watcher.close()
			rmSync(dir, { recursive: true, force: true })
		}
	}, 30_000)
})
