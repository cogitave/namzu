import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { type HookRow, type HooksReport, describeFolderHooks } from './hooks-report.js'

/**
 * One folder holding every kind of source at once: a user file in the common shape, a project file
 * in ours with a guard that cannot be loaded, a local file, a plugin with entries and a JavaScript
 * module, a skill, an agent file and a managed file.
 */

let root: string
let home: string
let cwd: string
let managedPath: string
const base = () => ({ cwd, home, env: {} as NodeJS.ProcessEnv, managedPath })

function put(path: string, text: string): void {
	mkdirSync(join(path, '..'), { recursive: true })
	writeFileSync(path, text)
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-hooks-report-'))
	home = join(root, 'home')
	cwd = join(root, 'project')
	managedPath = join(root, 'managed.json')
	put(
		join(home, '.namzu', 'config.yaml'),
		[
			'plugins:',
			'  enabled: true',
			'hooks:',
			'  PreToolUse:',
			'    - matcher: Bash',
			'      hooks:',
			'        - type: command',
			'          command: user-guard.sh',
			'          env:',
			'            SECRET_TOKEN: hunter2',
			'',
		].join('\n'),
	)
	put(
		join(cwd, 'namzu.config.json'),
		JSON.stringify({
			hooks: {
				turn_end: [{ command: 'project-done.sh', once: true }],
				session_start: [{ type: 'http', url: 'https://example.test/hook?token=abc#frag' }],
				pre_tool_use: [{ type: 'prompt', prompt: '\nIs this safe?\nSecond line' }],
				PostToolUse: ['this is not a hook'],
			},
		}),
	)
	put(
		join(cwd, 'namzu.config.local.json'),
		JSON.stringify({ hooks: { file_changed: [{ command: 'watch.sh', matcher: '(unclosed' }] } }),
	)
	put(
		join(cwd, '.namzu/plugins/demo/plugin.json'),
		JSON.stringify({
			name: 'demo',
			version: '1.0.0',
			description: 'demo',
			hooks: ['hooks.mjs'],
			hookEntries: { pre_tool_use: [{ command: 'plugin-guard.sh' }] },
		}),
	)
	put(join(cwd, '.namzu/plugins/demo/hooks.mjs'), 'throw new Error("must never be imported")\n')
	put(
		join(cwd, '.namzu/skills/careful/SKILL.md'),
		[
			'---',
			'name: careful',
			'description: Runs shell commands under a guard',
			'hooks:',
			'  PreToolUse:',
			'    - matcher: Bash',
			'      hooks:',
			'        - type: command',
			'          command: skill-guard.sh',
			'---',
			'Be careful.',
			'',
		].join('\n'),
	)
	put(
		join(cwd, '.namzu/agents/runner.md'),
		[
			'---',
			'name: runner',
			'description: Runs things',
			'hooks:',
			'  Stop:',
			'    - hooks:',
			'        - type: command',
			'          command: agent-done.sh',
			'---',
			'You run things.',
			'',
		].join('\n'),
	)
})

afterAll(() => removeTempDir(root))

const find = (report: HooksReport, predicate: (row: HookRow) => boolean): HookRow => {
	const row = report.hooks.find(predicate)
	if (!row) throw new Error(`no such row in ${JSON.stringify(report.hooks.map((r) => r.runs))}`)
	return row
}

describe('what runs by itself in a trusted folder', () => {
	let report: HooksReport
	beforeAll(async () => {
		report = await describeFolderHooks({ ...base(), trusted: true })
	})

	it('lists every kind of source with its event in both spellings, its matcher and its origin', () => {
		const user = find(report, (row) => row.runs === 'user-guard.sh')
		expect(user).toMatchObject({
			event: 'pre_tool_use',
			eventWritten: 'PreToolUse',
			matcher: 'Bash',
			type: 'command',
			state: 'runs',
			origin: { kind: 'config', scope: 'user' },
		})
		const project = find(report, (row) => row.runs === 'project-done.sh')
		expect(project).toMatchObject({
			event: 'turn_end',
			once: true,
			state: 'runs',
			origin: { kind: 'config', scope: 'project' },
		})
		expect(find(report, (row) => row.runs === 'watch.sh').origin.scope).toBe('local')
		expect(find(report, (row) => row.runs === 'plugin-guard.sh')).toMatchObject({
			state: 'runs',
			origin: { kind: 'plugin', name: 'demo', scope: 'project' },
		})
		expect(find(report, (row) => row.runs === 'skill-guard.sh')).toMatchObject({
			state: 'attaches-when-used',
			origin: { kind: 'skill', name: 'careful', scope: 'project' },
		})
		expect(find(report, (row) => row.runs === 'agent-done.sh')).toMatchObject({
			event: 'subagent_stop',
			state: 'attaches-when-used',
			origin: { kind: 'agent', name: 'runner' },
		})
	})

	it('says what an http hook reaches without its query, and the first line of a prompt', () => {
		expect(find(report, (row) => row.type === 'http').runs).toBe('POST https://example.test/hook')
		expect(find(report, (row) => row.type === 'prompt').runs).toBe('Is this safe?')
	})

	it('names the plugin module without importing it', () => {
		expect(report.modules).toEqual([
			expect.objectContaining({ plugin: 'demo', module: 'hooks.mjs', state: 'runs' }),
		])
	})

	it('reports a guard that cannot be loaded and a matcher that cannot be read', () => {
		expect(
			report.problems.some(
				(problem) =>
					problem.severity === 'problem' &&
					problem.origin.kind === 'config' &&
					problem.event === 'PostToolUse',
			),
		).toBe(true)
		const watch = find(report, (row) => row.runs === 'watch.sh')
		expect(watch.notes?.join(' ')).toContain('(unclosed')
	})

	it('never carries an environment value', () => {
		expect(JSON.stringify(report)).not.toContain('hunter2')
		expect(JSON.stringify(report)).not.toContain('token=abc')
	})

	it('keeps an id that is the same on the next look', async () => {
		const again = await describeFolderHooks({ ...base(), trusted: true })
		expect(again.hooks.map((row) => row.id)).toEqual(report.hooks.map((row) => row.id))
		expect(new Set(report.hooks.map((row) => row.id)).size).toBe(report.hooks.length)
	})

	it('counts the states and reports the switches as off', () => {
		expect(report.folder.trusted).toBe(true)
		expect(report.switches.disableHooks.on).toBe(false)
		expect(report.switches.hooksManagedOnly.on).toBe(false)
		expect(report.switches.plugins.on).toBe(true)
		expect(report.switches.limiting).toBeUndefined()
		expect(report.counts.waitingForTrust).toBe(0)
		expect(report.counts.runs + report.counts.attachesWhenUsed).toBe(report.hooks.length)
		expect(report.counts.problems).toBeGreaterThan(0)
	})
})

describe('a folder nobody has trusted', () => {
	it('lists what would start as not loaded, and counts nothing of it as running', async () => {
		const report = await describeFolderHooks({ ...base(), trusted: false })
		expect(report.folder.trusted).toBe(false)
		// The person's own file still runs.
		expect(find(report, (row) => row.runs === 'user-guard.sh').state).toBe('runs')
		for (const runs of [
			'project-done.sh',
			'watch.sh',
			'plugin-guard.sh',
			'skill-guard.sh',
			'agent-done.sh',
		]) {
			expect(find(report, (row) => row.runs === runs)).toMatchObject({
				state: 'not-loaded',
				why: { code: 'folder-not-trusted' },
			})
		}
		expect(report.counts.runs).toBe(1)
		expect(report.counts.waitingForTrust).toBeGreaterThanOrEqual(6)
		expect(report.modules[0]?.state).toBe('not-loaded')
		const lost = report.problems.find((problem) => problem.event === 'PostToolUse')
		expect(lost?.inactive).toBe('folder-not-trusted')
	})
})

describe('the switches', () => {
	it('says a user switch turned the hooks off, and where it was set', async () => {
		const report = await describeFolderHooks({
			...base(),
			trusted: true,
			env: { NAMZU_DISABLE_HOOKS: '1' },
		})
		expect(report.switches.limiting).toBe('disabled')
		expect(report.switches.disableHooks).toEqual({
			on: true,
			setBy: { kind: 'env', variable: 'NAMZU_DISABLE_HOOKS' },
		})
		for (const row of report.hooks) {
			expect(row.state, row.runs).toBe('off')
			expect(row.why?.code).toBe('disableHooks')
		}
		// A plugin's JavaScript hooks are not touched by it.
		expect(report.modules[0]?.state).toBe('runs')
		// The entries are still listed, so a person sees what the switch is holding back.
		expect(report.hooks.length).toBeGreaterThan(5)
	})

	it('keeps the managed file’s hooks running, and says managed-only outranks the rest', async () => {
		put(
			managedPath,
			JSON.stringify({
				hooksManagedOnly: true,
				hooks: { pre_tool_use: [{ command: 'managed-guard.sh' }] },
			}),
		)
		try {
			const report = await describeFolderHooks({ ...base(), trusted: true })
			expect(report.switches.limiting).toBe('managed-only')
			expect(report.switches.hooksManagedOnly.setBy?.kind).toBe('managed')
			expect(find(report, (row) => row.runs === 'managed-guard.sh')).toMatchObject({
				state: 'runs',
				origin: { scope: 'managed' },
			})
			expect(find(report, (row) => row.runs === 'user-guard.sh')).toMatchObject({
				state: 'off',
				why: { code: 'hooksManagedOnly' },
			})
			expect(find(report, (row) => row.runs === 'skill-guard.sh').state).toBe('off')
			expect(find(report, (row) => row.runs === 'plugin-guard.sh').state).toBe('off')
		} finally {
			writeFileSync(managedPath, '{}')
		}
	})

	it('says plugins are off when plugins.enabled is not on', async () => {
		put(
			join(home, '.namzu', 'config.yaml'),
			'hooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: only.sh\n',
		)
		try {
			const report = await describeFolderHooks({ ...base(), trusted: true })
			expect(report.switches.plugins.on).toBe(false)
			expect(find(report, (row) => row.runs === 'plugin-guard.sh')).toMatchObject({
				state: 'off',
				why: { code: 'plugins-disabled' },
			})
		} finally {
			// leave the folder as the other tests found it
			put(
				join(home, '.namzu', 'config.yaml'),
				'plugins:\n  enabled: true\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: user-guard.sh\n',
			)
		}
	})
})

describe('a skill that is switched off, and a switch a repository cannot set', () => {
	it('lists a skill named in skills.disabled as off, with the reason the docs name', async () => {
		const userFile = join(home, '.namzu', 'config.yaml')
		const original = readFileSync(userFile, 'utf8')
		put(userFile, `${original}skills:\n  disabled:\n    - careful\n`)
		try {
			const report = await describeFolderHooks({ ...base(), trusted: true })
			expect(find(report, (row) => row.runs === 'skill-guard.sh')).toMatchObject({
				state: 'off',
				why: { code: 'skill-disabled' },
			})
		} finally {
			put(userFile, original)
		}
	})

	it('says a project file\u2019s disableHooks is ignored, and that it switches nothing off', async () => {
		const folder = mkdtempSync(join(tmpdir(), 'namzu-hooks-report-ignored-'))
		try {
			put(
				join(folder, 'namzu.config.json'),
				JSON.stringify({ disableHooks: true, hooks: { turn_end: [{ command: 'tail.sh' }] } }),
			)
			const report = await describeFolderHooks({
				cwd: folder,
				home: join(folder, 'home'),
				env: {},
				managedPath: join(folder, 'none.json'),
				trusted: true,
			})
			expect(report.switches.disableHooks.on).toBe(false)
			expect(find(report, (row) => row.runs === 'tail.sh').state).toBe('runs')
			const note = report.problems.find((problem) => problem.event === 'disableHooks')
			expect(note).toMatchObject({ severity: 'note', origin: { scope: 'project' } })
			expect(note?.message).toContain('ignored')
			// A folder nobody trusted reports it as not yet applied.
			const untrusted = await describeFolderHooks({
				cwd: folder,
				home: join(folder, 'home'),
				env: {},
				managedPath: join(folder, 'none.json'),
				trusted: false,
			})
			expect(untrusted.problems.find((problem) => problem.event === 'disableHooks')?.inactive).toBe(
				'folder-not-trusted',
			)
		} finally {
			removeTempDir(folder)
		}
	})
})

describe('a folder with nothing in it', () => {
	it('answers with no hooks and no error', async () => {
		const empty = mkdtempSync(join(tmpdir(), 'namzu-hooks-report-empty-'))
		try {
			const report = await describeFolderHooks({
				cwd: empty,
				home: join(empty, 'home'),
				env: {},
				managedPath: join(empty, 'none.json'),
				trusted: true,
			})
			expect(report.hooks).toEqual([])
			expect(report.error).toBeUndefined()
			expect(report.version).toBe(1)
		} finally {
			removeTempDir(empty)
		}
	})
})
