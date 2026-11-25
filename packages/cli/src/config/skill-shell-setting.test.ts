import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigValueError, loadConfig, projectLayerHolds } from './load.js'
import { sessionOptionsFromConfig } from './session-options.js'

function setup(
	user?: unknown,
	project?: unknown,
	managed?: unknown,
	env: Record<string, string> = {},
) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-skillshell-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), JSON.stringify(user))
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-skillshell-cwd-'))
	if (project !== undefined) writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify(project))
	const managedPath = join(cwd, 'managed.json')
	if (managed !== undefined) writeFileSync(managedPath, JSON.stringify(managed))
	return { home, cwd, env, managedPath }
}

describe('disableSkillShellExecution', () => {
	it('is absent by default, which leaves the commands to run under the permission rules', () => {
		const cfg = loadConfig(setup())
		expect(cfg.disableSkillShellExecution).toBeUndefined()
		expect(sessionOptionsFromConfig(cfg, { cwd: '/p' }).skillShellDisabled).toBeUndefined()
	})

	it.each(['user', 'project', 'managed'] as const)('is honoured from the %s file', (layer) => {
		const on = { disableSkillShellExecution: true }
		const cfg = loadConfig(
			setup(
				layer === 'user' ? on : undefined,
				layer === 'project' ? on : undefined,
				layer === 'managed' ? on : undefined,
			),
		)
		expect(cfg.disableSkillShellExecution).toBe(true)
		expect(sessionOptionsFromConfig(cfg, { cwd: '/p' }).skillShellDisabled).toBe(true)
	})

	it('stays on when a later layer says off, and the managed layer cannot be lifted from below', () => {
		const user = { disableSkillShellExecution: true }
		const project = { disableSkillShellExecution: false }
		const managed = { disableSkillShellExecution: false }
		expect(loadConfig(setup(user, project, managed)).disableSkillShellExecution).toBe(true)
		expect(
			loadConfig(
				setup({ disableSkillShellExecution: false }, project, { disableSkillShellExecution: true }),
			).disableSkillShellExecution,
		).toBe(true)
	})

	it('is not read from the environment', () => {
		const cfg = loadConfig(
			setup(undefined, undefined, undefined, { NAMZU_DISABLE_SKILL_SHELL: '1' }),
		)
		expect(cfg.disableSkillShellExecution).toBeUndefined()
	})

	it('refuses a value that is not a boolean', () => {
		let error: unknown
		try {
			loadConfig(setup({ disableSkillShellExecution: 'yes' }))
		} catch (cause) {
			error = cause
		}
		expect(error).toBeInstanceOf(ConfigValueError)
		expect((error as ConfigValueError).settingPath).toBe('disableSkillShellExecution')
	})

	it('counts a project’s value only when it switches the commands off', () => {
		expect(projectLayerHolds('disableSkillShellExecution', true)).toBe(true)
		expect(projectLayerHolds('disableSkillShellExecution', false)).toBe(false)
	})
})
