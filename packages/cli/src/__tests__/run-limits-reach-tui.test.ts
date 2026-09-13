import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { resolveTrustedProjectContext } from '../config/trusted-project-context.js'
import type { TuiContext } from '../tui/types.js'

const launchTui = vi.hoisted(() => vi.fn(async (_ctx: TuiContext) => {}))
vi.mock('../tui/index.js', () => ({ launchTui }))
const { runCli } = await import('../cli.js')
const roots: string[] = []
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
afterEach(() => {
	launchTui.mockClear()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
	else Reflect.deleteProperty(process.stdout, 'isTTY')
	for (const root of roots.splice(0)) removeTempDir(root)
})

it.each([[], ['resume', '321be44d-6691-4832-b399-013abc59d851']])(
	'carries configured limits through bootstrap and trusted workspace resolution: %j',
	async (...args) => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-tui-limits-'))
		roots.push(root)
		const home = join(root, 'home')
		const cwd = join(root, 'workspace')
		mkdirSync(home)
		mkdirSync(cwd)
		vi.stubEnv('NAMZU_HOME', home)
		vi.spyOn(process, 'cwd').mockReturnValue(cwd)
		Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
		writeFileSync(join(home, 'config.yaml'), 'limits:\n  tokenBudget: 1000\n  maxIterations: 5\n')
		writeFileSync(
			join(cwd, 'namzu.config.json'),
			JSON.stringify({ limits: { tokenBudget: 2_000, maxIterations: 3 } }),
		)
		await expect(runCli({ argv: ['node', 'namzu', ...args] })).resolves.toBe(0)
		expect(launchTui).toHaveBeenCalledOnce()
		const bootstrap = launchTui.mock.calls[0]![0]
		expect(bootstrap.limits).toEqual({ tokenBudget: 1_000, maxIterations: 5 })
		expect(resolveTrustedProjectContext(bootstrap, cwd).limits).toEqual({
			tokenBudget: 2_000,
			maxIterations: 3,
		})
	},
)
