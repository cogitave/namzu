import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { HooksReport } from '../../config/hooks-report.js'
import { decideHeadlessTrust } from '../../permissions/headless-trust.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'
import { createDesktopHostExtensions } from '../desktop-host.js'

let root: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-desktop-host-hooks-'))
	cwd = join(root, 'project')
	mkdirSync(join(cwd, '.git'), { recursive: true })
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
	writeFileSync(
		join(cwd, 'namzu.config.json'),
		JSON.stringify({ hooks: { pre_tool_use: [{ command: 'guard.sh', matcher: 'bash' }] } }),
	)
	mkdirSync(join(cwd, '.namzu', 'plugins', 'p'), { recursive: true })
	writeFileSync(
		join(cwd, '.namzu', 'plugins', 'p', 'plugin.json'),
		JSON.stringify({ name: 'p', version: '1.0.0', description: 'p', hooks: ['boom.mjs'] }),
	)
	// A module that would be seen if anything imported it.
	writeFileSync(
		join(cwd, '.namzu', 'plugins', 'p', 'boom.mjs'),
		`import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(join(root, 'IMPORTED'))}, 'yes')\n`,
	)
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

function runtime() {
	return createCliAcpRuntime(
		{
			config: {},
			formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} },
		},
		{
			decideTrust: decideHeadlessTrust,
			resolveSession: async (sessionId: string) => ({ sessionId }),
		} as unknown as AcpRuntimeDependencies,
	)
}

it('answers about a folder nobody trusted without running or importing any of it, then as it runs once trusted', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	try {
		const before = (await host['namzu/hooks/list']({})) as HooksReport
		expect(before.version).toBe(1)
		expect(before.folder.trusted).toBe(false)
		const guard = before.hooks.find((row) => row.runs === 'guard.sh')
		expect(guard).toMatchObject({ state: 'not-loaded', why: { code: 'folder-not-trusted' } })
		expect(before.modules).toEqual([
			expect.objectContaining({ module: 'boom.mjs', state: 'not-loaded' }),
		])
		expect(before.counts.waitingForTrust).toBe(1)
		// Not a thing of the folder was imported: the module writes a file when it is.
		const { existsSync } = await import('node:fs')
		expect(existsSync(join(root, 'IMPORTED'))).toBe(false)

		host['namzu/project/trust']({ confirmed: true, cwd })
		const after = (await host['namzu/hooks/list']({})) as HooksReport
		expect(after.folder.trusted).toBe(true)
		expect(after.hooks.find((row) => row.runs === 'guard.sh')?.state).toBe('runs')
		expect(existsSync(join(root, 'IMPORTED'))).toBe(false)
	} finally {
		await owner.close()
	}
})

it('refuses a request that carries anything', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	try {
		await expect(host['namzu/hooks/list']({ cwd: '/elsewhere' })).rejects.toThrow(
			'Invalid hooks request',
		)
	} finally {
		await owner.close()
	}
})
