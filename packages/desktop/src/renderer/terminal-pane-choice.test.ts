import { describe, expect, it } from 'vitest'
import { chooseTerminalForPane } from './terminal-pane-choice.js'

const tab = (id: string, projectId: string, status: 'running' | 'exited' | 'restored') => ({
	id,
	projectId,
	status,
})

describe('chooseTerminalForPane', () => {
	it('starts a shell when the project has no terminal', () => {
		expect(chooseTerminalForPane([], 'p')).toEqual({ start: true })
	})
	it('reuses a live terminal instead of starting another', () => {
		expect(chooseTerminalForPane([tab('a', 'p', 'running')], 'p')).toEqual({ reuse: 'a' })
	})
	it('prefers the terminal that was in front', () => {
		const tabs = [tab('a', 'p', 'running'), tab('b', 'p', 'running')]
		expect(chooseTerminalForPane(tabs, 'p', 'b')).toEqual({ reuse: 'b' })
		expect(chooseTerminalForPane(tabs, 'p', 'gone')).toEqual({ reuse: 'a' })
	})
	it('ignores another project, and ended or restored terminals', () => {
		const tabs = [tab('x', 'q', 'running'), tab('e', 'p', 'exited'), tab('r', 'p', 'restored')]
		expect(chooseTerminalForPane(tabs, 'p')).toEqual({ start: true })
	})
	it('does not skip a live terminal behind an ended one', () => {
		expect(chooseTerminalForPane([tab('e', 'p', 'exited'), tab('a', 'p', 'running')], 'p')).toEqual(
			{
				reuse: 'a',
			},
		)
	})
})
