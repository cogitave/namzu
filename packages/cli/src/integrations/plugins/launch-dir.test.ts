import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { createCliPluginRuntime } from './runtime.js'

let root: string
let cwd: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-launch-dir-'))
	cwd = join(root, 'project')
	mkdirSync(cwd, { recursive: true })
	mkdirSync(join(root, 'home'), { recursive: true })
	vi.stubEnv('NAMZU_HOME', join(root, 'home'))
})

afterEach(() => {
	vi.unstubAllEnvs()
	removeTempDir(root)
})

describe('a plugin folder named for one launch', () => {
	it('loads from outside the project with plugins off, and lists its commands and agents', async () => {
		const dir = join(root, 'elsewhere', 'tryout')
		mkdirSync(join(dir, 'commands'), { recursive: true })
		mkdirSync(join(dir, 'agents'), { recursive: true })
		writeFileSync(join(dir, 'commands', 'audit.md'), 'Audit it.')
		writeFileSync(
			join(dir, 'agents', 'checker.md'),
			'---\nname: checker\ndescription: Checks things.\n---\nCHECK',
		)
		writeFileSync(
			join(dir, 'plugin.json'),
			JSON.stringify({
				name: 'tryout',
				version: '1.0.0',
				description: 'A plugin to try',
				commands: ['commands'],
				agents: ['agents'],
			}),
		)

		const runtime = await createCliPluginRuntime({ launchDirs: [dir] }, cwd)
		expect(runtime?.pluginCount).toBe(1)
		const [info] = runtime?.list() ?? []
		expect(info).toMatchObject({
			name: 'tryout',
			status: 'enabled',
			commands: ['tryout__audit'],
			agents: ['tryout__checker'],
		})
		await runtime?.close()
	})

	it('is no runtime at all when nothing is named and plugins are off', async () => {
		expect(await createCliPluginRuntime({}, cwd)).toBeUndefined()
	})

	it('refuses a folder with no manifest, naming the problem', async () => {
		const empty = join(root, 'empty')
		mkdirSync(empty)
		await expect(createCliPluginRuntime({ launchDirs: [empty] }, cwd)).rejects.toThrow(
			/Plugin runtime could not start/,
		)
	})
})
