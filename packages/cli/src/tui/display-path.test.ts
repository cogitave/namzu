import { describe, expect, it } from 'vitest'
import { displayPath, isSessionPlanPath } from './display-path.js'

describe('a path as a person reads it', () => {
	const cwd = '/home/me/work/app'
	const home = '/home/me'

	it('keeps a relative path inside the folder as the model gave it', () => {
		expect(displayPath('src/a.ts', cwd, home)).toBe('src/a.ts')
	})

	it('shows an absolute path inside the folder relative to it', () => {
		expect(displayPath('/home/me/work/app/src/a.ts', cwd, home)).toBe('src/a.ts')
	})

	it('never shows ../../x: under home it is ~/x', () => {
		expect(displayPath('../../notes/x.md', cwd, home)).toBe('~/notes/x.md')
		expect(displayPath('/home/me/notes/x.md', cwd, home)).toBe('~/notes/x.md')
	})

	it('shows the full path when the file is outside home too', () => {
		expect(displayPath('../../../../etc/hosts', cwd, home)).toBe('/etc/hosts')
		expect(displayPath('/tmp/scratch/x.txt', cwd, home)).toBe('/tmp/scratch/x.txt')
	})

	it('leaves an address alone', () => {
		expect(displayPath('https://example.com/a', cwd, home)).toBe('https://example.com/a')
	})

	it('calls a session plan file the plan, wherever the session folder is', () => {
		const plan =
			'/tmp/scratch/home/projects/-tmp-x-proje/01a17cc7-7d58-74be-8c86-9a9a0f7660a9/plans/plan.md'
		expect(displayPath(plan, cwd, home)).toBe('the plan')
		expect(displayPath(plan, undefined, home)).toBe('the plan')
		expect(
			displayPath(
				'C:\\Users\\me\\.namzu\\projects\\p\\01a17cc7-7d58-74be-8c86-9a9a0f7660a9\\plans\\plan.md',
				cwd,
				home,
			),
		).toBe('the plan')
	})

	it('knows the session folder by the configured Namzu home', () => {
		const plan = '/srv/namzu/projects/-x-proje/not-a-uuid/plans/plan.md'
		expect(isSessionPlanPath(plan, '/srv/namzu')).toBe(true)
		expect(isSessionPlanPath(plan, '/home/me/.namzu')).toBe(false)
		expect(isSessionPlanPath(plan, undefined)).toBe(false)
	})

	it('does not take a plan.md of a person\u2019s own projects folder for the plan', () => {
		const own = '/home/me/projects/app/src/plans/plan.md'
		expect(isSessionPlanPath(own, '/home/me/.namzu')).toBe(false)
		expect(displayPath(own, '/home/me/projects/app', home)).toBe('src/plans/plan.md')
		expect(displayPath(own, '/home/me/work', home)).toBe('~/projects/app/src/plans/plan.md')
	})

	it('leaves a plan.md of the project alone', () => {
		expect(displayPath('/home/me/work/app/docs/plans/plan.md', cwd, home)).toBe(
			'docs/plans/plan.md',
		)
	})
})
