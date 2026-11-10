import { expect, it } from 'vitest'
import { desktopFailure } from './diagnostics.js'
import { restoreProjects } from './restore-projects.js'

it('goes on to the next folder when one cannot be opened, and settles every path', async () => {
	const settled: string[] = []
	const failures: unknown[] = []
	const result = await restoreProjects(['/a', '/gone', '/b'], {
		open: async (path) => {
			if (path === '/gone') throw new Error('That folder no longer exists. Choose another folder.')
		},
		settle: (path) => settled.push(path),
		failed: (error) => failures.push(error),
		quitting: () => false,
	})
	expect(result).toEqual({ opened: 2, failed: 1 })
	expect(settled).toEqual(['/a', '/gone', '/b'])
	expect(failures.map((error) => desktopFailure(error).reason)).toEqual(['project-folder-missing'])
})

it('keeps restoring when the diagnostic sink itself throws', async () => {
	const settled: string[] = []
	const result = await restoreProjects(['/a', '/b'], {
		open: async () => {
			throw new Error('boom')
		},
		settle: (path) => settled.push(path),
		failed: () => {
			throw new Error('sink broken')
		},
		quitting: () => false,
	})
	expect(result.failed).toBe(2)
	expect(settled).toEqual(['/a', '/b'])
})

it('stops at the next path once the application is quitting', async () => {
	let quit = false
	const opened: string[] = []
	await restoreProjects(['/a', '/b'], {
		open: async (path) => {
			opened.push(path)
			quit = true
		},
		settle: () => {},
		failed: () => {},
		quitting: () => quit,
	})
	expect(opened).toEqual(['/a'])
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
