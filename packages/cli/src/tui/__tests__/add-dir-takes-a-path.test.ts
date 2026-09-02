import { describe, expect, it } from 'vitest'

import { composeEnvironmentPrompt } from '../../context/environment.js'
import { type SlashContext, runSlash } from '../slashCommands.js'

const ctx = (dirs: readonly string[]) =>
	({
		cwd: '/tmp',
		jobs: () => [],
		compaction: null,
		directories: () => dirs,
	}) as unknown as SlashContext

describe('/add-dir', () => {
	it('adds a path, and lists what was added when given none', () => {
		expect(runSlash('/add-dir ../shared', ctx([]))).toEqual({ kind: 'add-dir', path: '../shared' })
		expect(runSlash('/add-dir', ctx([]))?.kind).toBe('message')
		const listed = runSlash('/add-dir', ctx(['/srv/shared']))
		expect(listed?.kind === 'message' ? listed.content : '').toContain('/srv/shared')
	})

	it('is told to the model as a fact about the environment', () => {
		const prompt = composeEnvironmentPrompt({
			today: '2026-09-02',
			branch: 'main',
			isRepository: true,
			additionalDirectories: ['/srv/shared'],
		})
		expect(prompt).toContain('`/srv/shared`')
		expect(prompt).toContain('Relative paths still resolve against the working directory')
		expect(
			composeEnvironmentPrompt({ today: '2026-09-02', branch: 'main', isRepository: true }),
		).not.toContain('Besides the working directory')
	})
})
