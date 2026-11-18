import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readSettings } from './desktop-settings.js'
import { userConfigPath } from './user-config.js'

describe('readSettings says which layer decides a value', () => {
	let root: string
	let home: string
	let project: string
	let managed: string
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'namzu-layers-'))
		home = join(root, 'home')
		project = join(root, 'project')
		managed = join(root, 'managed.json')
		mkdirSync(join(home, '.namzu'), { recursive: true })
		mkdirSync(project, { recursive: true })
	})
	afterEach(() => rmSync(root, { recursive: true, force: true }))

	const read = (env: Record<string, string> = {}) =>
		readSettings({ home, cwd: project, managedPath: managed, env })
	const state = (path: string, env: Record<string, string> = {}) =>
		read(env).settings.find((s) => s.path === path)

	it('says nothing when only the user file or the default decides', () => {
		writeFileSync(userConfigPath({ home, env: {} }), 'limits:\n  maxResponseTokens: 500\n')
		const row = state('limits.maxResponseTokens')
		expect(row).toEqual({
			path: 'limits.maxResponseTokens',
			set: true,
			value: 500,
		})
	})

	it('reports an environment variable with its effective value, over a saved value', () => {
		writeFileSync(userConfigPath({ home, env: {} }), 'limits:\n  maxResponseTokens: 500\n')
		expect(state('limits.maxResponseTokens', { NAMZU_MAX_OUTPUT_TOKENS: '4096' })).toEqual({
			path: 'limits.maxResponseTokens',
			set: true,
			value: 500,
			layer: 'env',
			effective: 4096,
			env: { variable: 'NAMZU_MAX_OUTPUT_TOKENS', value: '4096' },
		})
		// Unset again: back to the plain row.
		expect(state('limits.maxResponseTokens')?.layer).toBeUndefined()
	})

	it('reads the other variables the loader reads', () => {
		const env = {
			NAMZU_FULLSCREEN: '1',
			NAMZU_QUIET: 'false',
			NAMZU_UPDATE_CHANNEL: 'Stable',
			NAMZU_AUTO_COMPACT_WINDOW: '200k',
		}
		expect(state('tui.fullscreen', env)).toMatchObject({
			layer: 'env',
			effective: true,
		})
		expect(state('quiet', env)).toMatchObject({
			layer: 'env',
			effective: false,
		})
		expect(state('updates.channel', env)).toMatchObject({
			layer: 'env',
			effective: 'stable',
		})
		expect(state('compaction.autoCompactWindowTokens', env)).toMatchObject({
			layer: 'env',
			effective: 200_000,
		})
		expect(state('tui.fullscreen', { NAMZU_FULLSCREEN: '0' })).toMatchObject({
			effective: false,
		})
	})

	it('names the variable but gives no value when the variable is unusable', () => {
		const row = state('limits.maxResponseTokens', {
			NAMZU_MAX_OUTPUT_TOKENS: 'lots',
		})
		expect(row?.layer).toBe('env')
		expect(row?.effective).toBeUndefined()
		expect(row?.env?.variable).toBe('NAMZU_MAX_OUTPUT_TOKENS')
	})

	it('reports the project file, and the local file over it', () => {
		writeFileSync(
			join(project, 'namzu.config.json'),
			JSON.stringify({
				limits: { maxIterations: 9, maxResponseTokens: 100 },
				tui: { fullscreen: true },
			}),
		)
		expect(state('limits.maxIterations')).toMatchObject({
			layer: 'project',
			effective: 9,
		})
		writeFileSync(
			join(project, 'namzu.config.local.json'),
			JSON.stringify({ limits: { maxIterations: 3 } }),
		)
		expect(state('limits.maxIterations')).toMatchObject({
			layer: 'local',
			effective: 3,
		})
		expect(state('limits.maxResponseTokens')).toMatchObject({
			layer: 'project',
			effective: 100,
		})
		// The environment beats the project, as the loader orders them.
		expect(state('limits.maxResponseTokens', { NAMZU_MAX_OUTPUT_TOKENS: '7' })).toMatchObject({
			layer: 'env',
			effective: 7,
		})
	})

	it('ignores a key a project file may not carry', () => {
		writeFileSync(join(project, 'namzu.config.json'), JSON.stringify({ smallModel: 'x/y' }))
		expect(state('smallModel')?.layer).toBeUndefined()
	})

	it('reports the managed file over everything, and never throws on a broken file', () => {
		writeFileSync(
			join(project, 'namzu.config.json'),
			JSON.stringify({ limits: { maxIterations: 9 } }),
		)
		writeFileSync(managed, JSON.stringify({ limits: { maxIterations: 2 } }))
		expect(state('limits.maxIterations', { NAMZU_MAX_OUTPUT_TOKENS: '1' })).toMatchObject({
			layer: 'managed',
			effective: 2,
		})
		writeFileSync(managed, '{ not json')
		expect(state('limits.maxIterations')).toMatchObject({
			layer: 'project',
			effective: 9,
		})
	})

	it('does not report a project value the loader drops or ignores', () => {
		writeFileSync(
			join(project, 'namzu.config.json'),
			JSON.stringify({
				tui: { fullscreen: true, theme: 'light', mouse: false },
				updates: { channel: 'stable', auto: true, check: true },
				disableHooks: true,
				sandbox: { enabled: false, allowEscape: true, teardownTimeoutMs: 5 },
				codeAnalysis: { enabled: true },
				learningGenerator: { cycleTokens: 1 },
				composerTriggers: { enabled: true },
			}),
		)
		for (const path of [
			'tui.fullscreen',
			'tui.theme',
			'updates.channel',
			'updates.auto',
			'updates.check',
			'disableHooks',
			'sandbox.enabled',
			'sandbox.allowEscape',
			'sandbox.teardownTimeoutMs',
			'codeAnalysis.enabled',
			'learningGenerator.cycleTokens',
			'composerTriggers.enabled',
		]) {
			expect(state(path)?.layer, path).toBeUndefined()
		}
		// What it may do still shows.
		expect(state('tui.mouse')).toMatchObject({ layer: 'project', effective: false })
	})

	it('reports a project value that only lowers', () => {
		writeFileSync(
			join(project, 'namzu.config.json'),
			JSON.stringify({
				updates: { auto: false, check: false },
				disableHooks: false,
				sandbox: { enabled: true, allowEscape: false, workspace: 'ephemeral' },
				codeAnalysis: { enabled: false },
				composerTriggers: { suggest: false },
			}),
		)
		for (const path of [
			'updates.auto',
			'updates.check',
			'sandbox.enabled',
			'sandbox.allowEscape',
			'sandbox.workspace',
			'codeAnalysis.enabled',
			'composerTriggers.suggest',
		]) {
			expect(state(path)?.layer, path).toBe('project')
		}
	})

	it('lets NAMZU_FULLSCREEN beat the managed file, as the terminal app does', () => {
		writeFileSync(managed, JSON.stringify({ tui: { fullscreen: true } }))
		expect(state('tui.fullscreen')).toMatchObject({ layer: 'managed' })
		expect(state('tui.fullscreen', { NAMZU_FULLSCREEN: '0' })).toMatchObject({
			layer: 'env',
			effective: false,
		})
	})

	it('says the update check variable decides updates.auto while it is off', () => {
		writeFileSync(userConfigPath({ home, env: {} }), 'updates:\n  auto: true\n')
		expect(state('updates.auto', { NAMZU_UPDATE_CHECK: '0' })).toMatchObject({
			layer: 'env',
			effective: false,
			env: { variable: 'NAMZU_UPDATE_CHECK', value: '0' },
		})
		expect(state('updates.auto', { NAMZU_UPDATE_CHECK: '1' })?.layer).toBeUndefined()
	})
	it('does not call a dropped project value the one in force for the bypass opt-in or computer use', () => {
		writeFileSync(
			join(project, 'namzu.config.json'),
			JSON.stringify({
				permissions: { allowBypassMode: true, disableBypassMode: true },
				computerUse: { enabled: true, deniedApps: ['Banking'] },
			}),
		)
		// The project cannot turn either on, and its denied apps add to the user's own list.
		expect(state('permissions.allowBypassMode')?.layer).toBeUndefined()
		expect(state('computerUse.enabled')?.layer).toBeUndefined()
		expect(state('computerUse.deniedApps')?.layer).toBeUndefined()
		// What a project may do still shows: it can forbid bypass and close computer use.
		expect(state('permissions.disableBypassMode')).toMatchObject({ layer: 'project' })
		writeFileSync(
			join(project, 'namzu.config.json'),
			JSON.stringify({ computerUse: { enabled: false } }),
		)
		expect(state('computerUse.enabled')).toMatchObject({ layer: 'project', effective: false })
	})
})
