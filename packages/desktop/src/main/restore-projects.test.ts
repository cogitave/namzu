import { describe, expect, it, vi } from 'vitest'
import { desktopFailure } from './diagnostics.js'
import { RESTORE_CONCURRENCY, restoreProjects } from './restore-projects.js'

function gates(paths: string[]) {
	const log: string[] = []
	const release = new Map<string, () => void>()
	const open = (path: string) =>
		new Promise<void>((resolve, reject) => {
			log.push(`open:${path}`)
			release.set(path, () => (path.startsWith('bad') ? reject(new Error(path)) : resolve()))
		})
	return { log, release, open, paths }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('restoreProjects', () => {
	it('starts up to three at once, in order, and the next as one finishes', async () => {
		const g = gates(['a', 'b', 'c', 'd', 'e'])
		const settled: string[] = []
		const run = restoreProjects({
			paths: g.paths,
			stopped: () => false,
			open: g.open,
			settle: (path) => settled.push(path),
			failed: () => undefined,
		})
		await flush()
		expect(RESTORE_CONCURRENCY).toBe(3)
		expect(g.log).toEqual(['open:a', 'open:b', 'open:c'])
		g.release.get('b')?.()
		await flush()
		expect(g.log).toEqual(['open:a', 'open:b', 'open:c', 'open:d'])
		for (const path of ['a', 'c', 'd']) g.release.get(path)?.()
		await flush()
		g.release.get('e')?.()
		await run
		expect(settled.sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
	})

	it('settles a failed project, reports it, and goes on with the rest', async () => {
		const g = gates(['bad1', 'ok'])
		const failed = vi.fn()
		const settled: string[] = []
		const run = restoreProjects({
			paths: g.paths,
			limit: 1,
			stopped: () => false,
			open: g.open,
			settle: (path) => settled.push(path),
			failed,
		})
		await flush()
		g.release.get('bad1')?.()
		await flush()
		g.release.get('ok')?.()
		await run
		expect(failed).toHaveBeenCalledTimes(1)
		expect(settled).toEqual(['bad1', 'ok'])
	})

	it('starts nothing new once the app is quitting', async () => {
		const g = gates(['a', 'b', 'c'])
		let quitting = false
		const run = restoreProjects({
			paths: g.paths,
			limit: 1,
			stopped: () => quitting,
			open: g.open,
			settle: () => undefined,
			failed: () => undefined,
		})
		await flush()
		quitting = true
		g.release.get('a')?.()
		await run
		expect(g.log).toEqual(['open:a'])
	})

	it('takes the time of the slowest, not the sum (3 projects of 400 ms: 400 ms, not 1200 ms)', async () => {
		vi.useFakeTimers()
		try {
			const open = () => new Promise<void>((resolve) => setTimeout(resolve, 400))
			const started = Date.now()
			let took = 0
			const run = restoreProjects({
				paths: ['a', 'b', 'c'],
				stopped: () => false,
				open,
				settle: () => undefined,
				failed: () => undefined,
			}).then(() => {
				took = Date.now() - started
			})
			await vi.advanceTimersByTimeAsync(1200)
			await run
			expect(took).toBe(400)
		} finally {
			vi.useRealTimers()
		}
	})

	it('does nothing for no projects', async () => {
		await restoreProjects({
			paths: [],
			stopped: () => false,
			open: () => Promise.reject(new Error('never')),
			settle: () => undefined,
			failed: () => undefined,
		})
	})
})

describe('restoreProjects when a folder cannot be opened', () => {
	it('names the reason, keeps going and settles every path', async () => {
		const settled: string[] = []
		const failures: unknown[] = []
		await restoreProjects({
			paths: ['/a', '/gone', '/b'],
			limit: 1,
			stopped: () => false,
			open: async (path) => {
				if (path === '/gone')
					throw new Error('That folder no longer exists. Choose another folder.')
			},
			settle: (path) => settled.push(path),
			failed: (error) => failures.push(error),
		})
		expect(settled).toEqual(['/a', '/gone', '/b'])
		expect(failures.map((error) => desktopFailure(error).reason)).toEqual([
			'project-folder-missing',
		])
	})

	it('keeps restoring when recording the failure itself throws', async () => {
		const settled: string[] = []
		await restoreProjects({
			paths: ['/a', '/b'],
			limit: 1,
			stopped: () => false,
			open: async () => {
				throw new Error('boom')
			},
			settle: (path) => settled.push(path),
			failed: () => {
				throw new Error('sink broken')
			},
		})
		expect(settled).toEqual(['/a', '/b'])
	})

	it('names why a saved folder could not be opened, so a person can act on it', () => {
		const reason = (message: string) => desktopFailure(new Error(message)).reason
		expect(reason('This folder no longer exists: /x')).toBe('project-folder-missing')
		expect(reason('Namzu can’t open that folder. Check that you have access to it.')).toBe(
			'project-folder-unreadable',
		)
		expect(reason('Namzu could not open this folder.')).toBe('project-folder-unreadable')
		expect(reason('That is a file, not a folder. Choose a folder.')).toBe(
			'project-folder-not-a-directory',
		)
		expect(reason('Namzu is closing.')).toBe('app-closing')
	})
})
