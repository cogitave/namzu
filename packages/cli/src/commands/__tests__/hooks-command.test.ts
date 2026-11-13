import { describe, expect, it } from 'vitest'
import type { HooksReport } from '../../config/hooks-report.js'
import { parseHooksFlags, renderHooksReport } from '../hooks.js'

describe('namzu hooks flags', () => {
	it('reads --cwd and --json, and refuses what it does not know', () => {
		expect(parseHooksFlags(['--json', '--cwd', '/x'])).toEqual({ cwd: '/x', json: true })
		expect(parseHooksFlags(['--cwd=/y'])).toEqual({ cwd: '/y', json: false })
		expect(parseHooksFlags(['--cwd']).error).toContain('--cwd')
		expect(parseHooksFlags(['--nope']).error).toContain('--nope')
	})
})

describe('namzu hooks text', () => {
	const report: HooksReport = {
		version: 1,
		folder: { path: '/work/app', trusted: false },
		switches: {
			disableHooks: { on: false },
			hooksManagedOnly: { on: false },
			plugins: { on: true, setBy: { kind: 'user-file', path: '~/.namzu/config.yaml' } },
		},
		hooks: [
			{
				id: 'a',
				event: 'pre_tool_use',
				eventWritten: 'PreToolUse',
				matcher: 'Bash',
				type: 'command',
				runs: './guard.sh',
				origin: { kind: 'config', label: '/work/app/namzu.config.json', scope: 'project' },
				state: 'not-loaded',
				why: { code: 'folder-not-trusted', text: 'This folder is not trusted.' },
			},
		],
		modules: [],
		problems: [
			{
				severity: 'problem',
				origin: { kind: 'config', label: '/work/app/namzu.config.json' },
				event: 'PostToolUse',
				message: 'entry 1 is not a mapping.',
				inactive: 'folder-not-trusted',
			},
		],
		counts: {
			runs: 0,
			off: 0,
			attachesWhenUsed: 0,
			notLoaded: 1,
			waitingForTrust: 1,
			problems: 1,
		},
	}

	it('says the folder is not trusted and what would start, state by state', () => {
		const text = renderHooksReport(report)
		expect(text).toContain('(not trusted)')
		expect(text).toContain('1 hook in it would start once it is')
		expect(text).toContain('pre_tool_use (PreToolUse) · matches Bash · command: ./guard.sh')
		expect(text).toContain('not loaded: This folder is not trusted.')
		expect(text).toContain('Not loaded: /work/app/namzu.config.json, PostToolUse')
		expect(text).toContain('not applied until the folder is trusted')
		expect(text).toContain('plugins on (user-file: ~/.namzu/config.yaml)')
	})
})
