import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { TuiContext } from '../tui/types.js'

const launchTui = vi.hoisted(() => vi.fn(async (_ctx: TuiContext) => {}))
vi.mock('../tui/index.js', () => ({ launchTui }))
const { runCli } = await import('../cli.js')
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
let root = ''
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-launch-profile-'))
	mkdirSync(join(root, 'state'))
	vi.spyOn(process, 'cwd').mockReturnValue(root)
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
	Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
})
afterEach(() => {
	launchTui.mockClear()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
	else Reflect.deleteProperty(process.stdout, 'isTTY')
	removeTempDir(root)
})

it('starts a complete process-local profile without a config file', async () => {
	vi.stubEnv('NAMZU_PROVIDER', 'openai')
	vi.stubEnv('NAMZU_MODEL', 'profile-main')
	vi.stubEnv('NAMZU_EFFORT_LEVEL', 'max')
	vi.stubEnv('NAMZU_SMALL_MODEL', 'openai/profile-small')
	vi.stubEnv('NAMZU_MAX_OUTPUT_TOKENS', '32768')
	vi.stubEnv('NAMZU_AUTO_COMPACT_WINDOW', '786432')
	expect(await runCli({ argv: ['node', 'namzu'] })).toBe(0)
	expect(launchTui.mock.calls[0]?.[0]).toMatchObject({
		launchSettings: { provider: 'openai', model: 'profile-main', effort: 'max' },
		smallModel: 'openai/profile-small',
		limits: { maxResponseTokens: 32768 },
		compaction: { autoCompactWindowTokens: 786432 },
	})
})

it('lets invocation flags override the exported main model, effort and output cap', async () => {
	vi.stubEnv('NAMZU_PROVIDER', 'openai')
	vi.stubEnv('NAMZU_MODEL', 'env-model')
	vi.stubEnv('NAMZU_EFFORT_LEVEL', 'max')
	vi.stubEnv('NAMZU_MAX_OUTPUT_TOKENS', '16384')
	expect(
		await runCli({
			argv: [
				'node',
				'namzu',
				'--model',
				'flag-model',
				'--effort',
				'low',
				'--max-output-tokens',
				'32768',
			],
		}),
	).toBe(0)
	expect(launchTui.mock.calls[0]?.[0]).toMatchObject({
		launchSettings: { provider: 'openai', model: 'flag-model', effort: 'low' },
		limits: { maxResponseTokens: 32768 },
	})
})

it('does not treat exported model choices as misplaced flags on unrelated commands', async () => {
	vi.stubEnv('NAMZU_MODEL', 'profile-main')
	vi.stubEnv('NAMZU_EFFORT_LEVEL', 'not-a-level')
	expect(await runCli({ argv: ['node', 'namzu', '--version'] })).toBe(0)
	expect(launchTui).not.toHaveBeenCalled()
})

it.each(['0', '-1', '1.5', '9007199254740992'])(
	'refuses an invalid --max-output-tokens %s',
	async (value) => {
		expect(await runCli({ argv: ['node', 'namzu', '--max-output-tokens', value] })).toBe(64)
		expect(launchTui).not.toHaveBeenCalled()
	},
)
