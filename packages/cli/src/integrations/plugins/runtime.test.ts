import { ToolRegistry } from '@namzu/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createCliPluginRuntime } from './runtime.js'

const discovery = vi.hoisted(() => ({
	options: undefined as unknown,
	calls: 0,
}))

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		discoverAllPluginDirs: vi.fn(async (_cwd, options) => {
			discovery.calls++
			discovery.options = options
			return { project: [], user: [] }
		}),
	}
})

beforeEach(() => {
	discovery.calls = 0
	discovery.options = undefined
})

describe('CLI plugin discovery authority', () => {
	it('passes the exact admitted scopes and discovery switch to the SDK scanner', async () => {
		const runtime = await createCliPluginRuntime(
			{ enabled: true, autoDiscovery: false, allowedScopes: ['user'] },
			new ToolRegistry(),
			'/trusted/project',
		)

		expect(discovery.calls).toBe(1)
		expect(discovery.options).toEqual(
			expect.objectContaining({
				enabled: true,
				autoDiscovery: false,
				allowedScopes: ['user'],
			}),
		)
		await runtime?.close()
	})
})
