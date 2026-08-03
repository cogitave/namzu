import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PluginRuntimeConfigSchema } from '../../config/runtime.js'
import {
	PLUGIN_MANIFEST_FILENAME,
	PROJECT_PLUGIN_DIR,
	USER_PLUGIN_DIR,
} from '../../constants/plugin/index.js'

/**
 * `allowedScopes` read exactly like a trust boundary and enforced nothing.
 *
 * A plugin is arbitrary code with hooks into tool execution, and the two
 * scopes are not equally trusted: a project plugin is reviewable in the repo
 * the agent works on, a user plugin comes from a home directory the repo's
 * reviewers never see. `PluginRuntimeConfig` carried `enabled`,
 * `autoDiscovery` and `allowedScopes`; nothing anywhere consulted any of the
 * three, and discovery scanned both locations unconditionally.
 */

let home: string
let workdir: string

vi.mock('node:os', async () => {
	const actual = await vi.importActual<typeof import('node:os')>('node:os')
	return { ...actual, homedir: () => home }
})

async function plantPlugin(dir: string, name: string): Promise<void> {
	const pluginDir = join(dir, name)
	await mkdir(pluginDir, { recursive: true })
	await writeFile(
		join(pluginDir, PLUGIN_MANIFEST_FILENAME),
		JSON.stringify({ name, version: '1.0.0' }),
		'utf-8',
	)
}

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), 'namzu-home-'))
	workdir = await mkdtemp(join(tmpdir(), 'namzu-work-'))
	await plantPlugin(join(workdir, PROJECT_PLUGIN_DIR), 'project-plugin')
	await plantPlugin(join(home, USER_PLUGIN_DIR), 'user-plugin')
})

afterEach(async () => {
	await Promise.all([
		rm(home, { recursive: true, force: true }),
		rm(workdir, { recursive: true, force: true }),
	])
})

async function discover(
	options?: Parameters<typeof import('../loader.js').discoverAllPluginDirs>[1],
) {
	const { discoverAllPluginDirs } = await import('../loader.js')
	return discoverAllPluginDirs(workdir, options)
}

describe('a scope the host did not allow is not scanned', () => {
	it('finds both when nothing is said', async () => {
		const found = await discover()

		expect(found.project).toHaveLength(1)
		expect(found.user).toHaveLength(1)
	})

	it('keeps user plugins out when only project is allowed', async () => {
		const found = await discover({ allowedScopes: ['project'] })

		expect(found.project).toHaveLength(1)
		// The setting that reads like a boundary now is one.
		expect(found.user).toEqual([])
	})

	it('keeps project plugins out when only user is allowed', async () => {
		const found = await discover({ allowedScopes: ['user'] })

		expect(found.project).toEqual([])
		expect(found.user).toHaveLength(1)
	})

	it('finds nothing when neither scope is allowed', async () => {
		const found = await discover({ allowedScopes: [] })

		expect(found).toEqual({ project: [], user: [] })
	})
})

describe('the runtime switches turn discovery off', () => {
	it('discovers nothing when the plugin runtime is disabled', async () => {
		const found = await discover({ enabled: false })

		expect(found).toEqual({ project: [], user: [] })
	})

	it('discovers nothing when auto-discovery is off', async () => {
		const found = await discover({ autoDiscovery: false })

		expect(found).toEqual({ project: [], user: [] })
	})

	it('a default-parsed config discovers nothing, because the runtime ships off', async () => {
		// `enabled` defaults to false in the schema. A host who parses the
		// config and passes it gets the documented default rather than a
		// silently-on plugin runtime.
		const found = await discover(PluginRuntimeConfigSchema.parse({}))

		expect(found).toEqual({ project: [], user: [] })
	})

	it('an enabled default-parsed config finds both scopes', async () => {
		const found = await discover(PluginRuntimeConfigSchema.parse({ enabled: true }))

		expect(found.project).toHaveLength(1)
		expect(found.user).toHaveLength(1)
	})

	it('a parsed config carries its scope restriction through', async () => {
		const config = PluginRuntimeConfigSchema.parse({
			enabled: true,
			allowedScopes: ['project'],
		})

		const found = await discover(config)

		expect(found.project).toHaveLength(1)
		expect(found.user).toEqual([])
	})
})
