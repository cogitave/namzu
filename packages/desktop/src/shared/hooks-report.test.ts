import { describe, expect, it } from 'vitest'
import { readHooksReport, safeRuns } from './hooks-report.js'

const row = (over: Record<string, unknown> = {}) => ({
	id: 'a1',
	event: 'pre_tool_use',
	eventWritten: 'PreToolUse',
	matcher: 'Bash',
	type: 'command',
	runs: './guard.sh --strict',
	origin: { kind: 'config', label: '/work/app/namzu.config.json', scope: 'project' },
	state: 'runs',
	...over,
})
const answer = (over: Record<string, unknown> = {}) => ({
	version: 1,
	folder: { path: '/work/app', trusted: true },
	switches: {
		disableHooks: { on: false },
		hooksManagedOnly: { on: false },
		plugins: { on: true },
	},
	hooks: [row()],
	modules: [],
	problems: [],
	counts: { runs: 1, off: 0, attachesWhenUsed: 0, notLoaded: 0, waitingForTrust: 0, problems: 0 },
	...over,
})

describe('reading the engine’s answer about hooks', () => {
	it('keeps what it knows and nothing else, so a header or an env value never reaches the screen', () => {
		const report = readHooksReport(
			answer({
				hooks: [
					row({
						type: 'http',
						runs: 'POST https://hooks.example/ingest',
						headers: { Authorization: 'Bearer SECRET-HEADER' },
						env: { API_TOKEN: 'SECRET-ENV' },
						url: 'https://user:SECRET-URL@hooks.example/ingest?key=SECRET-QUERY',
					}),
				],
			}),
		)
		const text = JSON.stringify(report)
		expect(text).not.toContain('SECRET')
		expect(report?.hooks[0]).toMatchObject({
			type: 'http',
			runs: 'POST https://hooks.example/ingest',
		})
		expect(report?.hooks[0]).not.toHaveProperty('headers')
		expect(report?.hooks[0]).not.toHaveProperty('env')
	})

	it('removes credentials and queries from a line even if the engine left them in', () => {
		expect(safeRuns('POST https://user:pw@host.example/x?token=abc#frag')).toBe(
			'POST https://host.example/x',
		)
		expect(safeRuns('deploy --api-key=abc123 --verbose')).toBe('deploy --api-key=… --verbose')
		expect(safeRuns('API_TOKEN=abc node run.mjs')).toBe('API_TOKEN=… node run.mjs')
		expect(safeRuns('curl -H "Authorization: Bearer abc"')).not.toContain('abc')
		const report = readHooksReport(
			answer({ hooks: [row({ runs: 'run.sh --password=hunter2\u0007' })] }),
		)
		expect(report?.hooks[0]?.runs).toBe('run.sh --password=…')
	})

	it('counts what it cannot read instead of dropping it silently, and never invents a hook', () => {
		const report = readHooksReport(
			answer({
				hooks: [row(), { id: 'broken' }, null, row({ id: 'b2', origin: { kind: 'robot' } })],
			}),
		)
		expect(report?.hooks.map((hook) => hook.id)).toEqual(['a1'])
		expect(report?.unreadable).toBe(3)
	})

	it('reads a state it does not know as not loaded, never as running', () => {
		const report = readHooksReport(answer({ hooks: [row({ state: 'sleeping' })] }))
		expect(report?.hooks[0]?.state).toBe('not-loaded')
	})

	it('is not an answer unless it has a version and a list', () => {
		for (const bad of [null, 'x', {}, { version: 1 }, { hooks: [] }, [] as unknown])
			expect(readHooksReport(bad)).toBeUndefined()
	})

	it('reads the switches with where each was set, and ignores fields a newer engine adds', () => {
		const report = readHooksReport(
			answer({
				version: 2,
				newField: { anything: true },
				switches: {
					disableHooks: { on: true, setBy: { kind: 'env', variable: 'NAMZU_DISABLE_HOOKS' } },
					hooksManagedOnly: { on: false },
					plugins: { on: false, setBy: { kind: 'user-file', path: '~/.namzu/config.yaml' } },
					limiting: 'disabled',
				},
			}),
		)
		expect(report?.version).toBe(2)
		expect(report?.switches.disableHooks).toEqual({
			on: true,
			setBy: { kind: 'env', variable: 'NAMZU_DISABLE_HOOKS' },
		})
		expect(report?.switches.limiting).toBe('disabled')
		expect(report).not.toHaveProperty('newField')
	})
})
