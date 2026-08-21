/** The default CLI action must carry resolved provenance across the dynamic TUI boundary. */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { resolveTrustedProjectContext } from '../config/trusted-project-context.js'
import type { TuiContext } from '../tui/types.js'

const launchTui = vi.hoisted(() => vi.fn(async (_ctx: TuiContext) => {}))

vi.mock('../tui/index.js', () => ({ launchTui }))

const { runCli } = await import('../cli.js')

describe('configuration provenance reaches the TUI launch', () => {
	const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
	let cwd = ''

	afterEach(() => {
		launchTui.mockClear()
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		if (cwd) removeTempDir(cwd)
		cwd = ''
		if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
		else Reflect.deleteProperty(process.stdout, 'isTTY')
	})

	it('retains the selected profile and attributes exact CLI overrides', async () => {
		cwd = mkdtempSync(join(tmpdir(), 'namzu-config-debug-'))
		const projectPath = join(cwd, 'namzu.config.json')
		writeFileSync(
			projectPath,
			JSON.stringify({
				profiles: { ci: { format: 'json', quiet: false } },
				permissions: { bash: { '*': 'ask' } },
				plugins: { enabled: true, allowedScopes: ['project'] },
			}),
		)
		vi.spyOn(process, 'cwd').mockReturnValue(cwd)
		Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })

		await expect(
			runCli({
				argv: ['node', 'namzu', '--profile', 'ci', '--format', 'yaml', '--quiet'],
			}),
		).resolves.toBe(0)

		expect(launchTui).toHaveBeenCalledOnce()
		const bootstrap = launchTui.mock.calls[0]![0]
		expect(bootstrap.rules).toEqual([])
		const trusted = resolveTrustedProjectContext(bootstrap, cwd)
		expect(trusted).toEqual(
			expect.objectContaining({
				cwd,
				plugins: { enabled: true, allowedScopes: ['project'] },
				configDebug: expect.objectContaining({
					selectedProfile: { name: 'ci', selectedBy: '--profile' },
					sources: expect.objectContaining({
						format: { kind: 'cli-flag', flag: '--format' },
						quiet: { kind: 'cli-flag', flag: '--quiet' },
						permissions: { kind: 'project-file', path: projectPath },
					}),
				}),
			}),
		)
	})

	it('attributes profile selection from the environment when no flag was present', async () => {
		cwd = mkdtempSync(join(tmpdir(), 'namzu-config-debug-env-'))
		writeFileSync(
			join(cwd, 'namzu.config.json'),
			JSON.stringify({ profiles: { debug_env_profile: { format: 'json' } } }),
		)
		vi.spyOn(process, 'cwd').mockReturnValue(cwd)
		vi.stubEnv('NAMZU_PROFILE', 'debug_env_profile')
		Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })

		await expect(runCli({ argv: ['node', 'namzu'] })).resolves.toBe(0)

		const bootstrap = launchTui.mock.calls[0]![0]
		const trusted = resolveTrustedProjectContext(bootstrap, cwd)
		expect(trusted).toEqual(
			expect.objectContaining({
				configDebug: expect.objectContaining({
					selectedProfile: {
						name: 'debug_env_profile',
						selectedBy: 'NAMZU_PROFILE',
					},
				}),
			}),
		)
	})

	it('launches the trust screen without parsing malformed project config', async () => {
		cwd = mkdtempSync(join(tmpdir(), 'namzu-config-debug-untrusted-'))
		writeFileSync(join(cwd, 'namzu.config.json'), '{ "format": ')
		vi.spyOn(process, 'cwd').mockReturnValue(cwd)
		Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })

		await expect(runCli({ argv: ['node', 'namzu'] })).resolves.toBe(0)

		expect(launchTui).toHaveBeenCalledOnce()
		expect(() => resolveTrustedProjectContext(launchTui.mock.calls[0]![0], cwd)).toThrow(
			/namzu\.config\.json/,
		)
	})

	it("does not invent a selected profile for the loader's empty-value no-op", async () => {
		cwd = mkdtempSync(join(tmpdir(), 'namzu-config-debug-empty-profile-'))
		vi.spyOn(process, 'cwd').mockReturnValue(cwd)
		vi.stubEnv('NAMZU_PROFILE', '')
		Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })

		await expect(runCli({ argv: ['node', 'namzu'] })).resolves.toBe(0)

		expect(launchTui).toHaveBeenCalledWith(
			expect.objectContaining({
				configDebug: expect.not.objectContaining({ selectedProfile: expect.anything() }),
			}),
		)
	})
})
