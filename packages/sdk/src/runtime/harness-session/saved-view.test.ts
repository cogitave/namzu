import { describe, expect, it } from 'vitest'
import { engineSavedView } from './saved-view.js'

const label = (view: ReturnType<typeof engineSavedView>) =>
	view.kind === 'generic' ? view.label : `${view.kind}:${(view as { command?: string }).command}`

describe('engineSavedView', () => {
	it('keeps the first line of a shell command, never the output', () => {
		expect(engineSavedView('Bash', { command: 'ls -la\nrm x' })).toEqual({
			kind: 'terminal',
			command: 'ls -la',
			output: '',
		})
		expect(engineSavedView('exec_command', { command: ['git', 'status'] })).toMatchObject({
			command: 'git status',
		})
		expect(label(engineSavedView('Bash', {}))).toBe('Ran command')
	})

	it('bounds a long command to 200 characters', () => {
		const view = engineSavedView('Bash', { command: 'x'.repeat(500) })
		expect(view.kind === 'terminal' && Array.from(view.command ?? '').length).toBe(200)
	})

	it('names files, searches, agents and tasks', () => {
		expect(label(engineSavedView('Read', { file_path: '/a/b/c.ts' }))).toBe('Read c.ts')
		expect(label(engineSavedView('Edit', { file_path: 'C:\\a\\d.ts' }))).toBe('Edited d.ts')
		expect(label(engineSavedView('Write', { file_path: '/a/e.md' }))).toBe('Wrote e.md')
		expect(label(engineSavedView('Grep', { pattern: 'foo' }))).toBe('Searched for foo')
		expect(
			label(engineSavedView('Task', { subagent_type: 'explore', description: 'map it' })),
		).toBe('Ran agent explore · map it')
		expect(label(engineSavedView('spawnAgent', {}))).toBe('Ran agent')
		expect(label(engineSavedView('TodoWrite', { todos: [] }))).toBe('Updated tasks')
	})

	it('names the agent lifecycle tools, matching the Desktop history fallback', () => {
		// Mirrored by packages/desktop/src/shared/history-work.test.ts; change both together.
		expect(label(engineSavedView('wait_agent', {}))).toBe('Waited for agent')
		expect(label(engineSavedView('close_agent', {}))).toBe('Stopped agent')
		expect(label(engineSavedView('interruptAgent', {}))).toBe('Stopped agent')
		expect(label(engineSavedView('update_plan', {}))).toBe('Updated tasks')
	})

	it('names an unknown tool instead of calling it saved', () => {
		expect(label(engineSavedView('server.fetch_page', {}))).toBe('Used fetch page')
		expect(label(engineSavedView('mcp__srv__DoThing', null))).toBe('Used do thing')
	})

	it('marks labels as authored activity', () => {
		expect(engineSavedView('Read', {})).toMatchObject({ presentation: 'activity' })
	})
})
