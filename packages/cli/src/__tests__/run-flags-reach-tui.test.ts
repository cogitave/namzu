import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { AuthorizationGate, NOOP_LOGGER } from '@namzu/sdk'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { TuiContext } from '../tui/types.js'

const launchTui = vi.hoisted(() => vi.fn(async (_ctx: TuiContext) => {}))
vi.mock('../tui/index.js', () => ({ launchTui }))
const { runCli } = await import('../cli.js')

const roots: string[] = []
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
let stderr = ''
let writeStderr: typeof process.stderr.write

beforeEach(() => {
	stderr = ''
	writeStderr = process.stderr.write.bind(process.stderr)
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
		return true
	}) as typeof process.stderr.write
	const root = mkdtempSync(join(tmpdir(), 'namzu-run-flags-tui-'))
	roots.push(root)
	const home = join(root, 'home')
	const cwd = join(root, 'workspace')
	mkdirSync(home)
	mkdirSync(cwd)
	vi.stubEnv('NAMZU_HOME', home)
	vi.spyOn(process, 'cwd').mockReturnValue(cwd)
	Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
})

afterEach(() => {
	process.stderr.write = writeStderr
	launchTui.mockClear()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
	else Reflect.deleteProperty(process.stdout, 'isTTY')
	for (const root of roots.splice(0)) removeTempDir(root)
})

const flat = (text: string) => text.replace(/\s+/g, ' ')
const argv = (...args: string[]) => ['node', 'namzu', ...args]

function decision(ctx: TuiContext, toolName: string, toolInput: object): string {
	const gate = new AuthorizationGate(
		{
			enabled: true,
			rules: [...(ctx.rules ?? [])],
			allowReadOnlyTools: false,
			denyDangerousPatterns: false,
			logDecisions: false,
		},
		NOOP_LOGGER,
	)
	return gate.evaluate({ toolName, toolInput, toolDef: undefined, commandDialect: 'sh' } as never)
		.decision
}

it('carries the appended instructions, the tool lists and the fallback models into the terminal session', async () => {
	await expect(
		runCli({
			argv: argv(
				'--append-system-prompt',
				'Reply in one line.',
				'--allowed-tools',
				'edit',
				'--disallowed-tools',
				'bash(rm *)',
				'--fallback-model',
				'openai/small,other',
			),
		}),
	).resolves.toBe(0)
	const ctx = launchTui.mock.calls[0]?.[0]
	if (!ctx) throw new Error('the terminal session was not launched')
	expect(ctx.appendSystem).toBe('Reply in one line.')
	expect(ctx.launchSettings?.fallbackModels).toEqual(['openai/small,other'])
	expect(decision(ctx, 'edit', { path: 'a' })).toBe('allow')
	expect(decision(ctx, 'bash', { command: 'rm -rf x' })).toBe('deny')
})

it('adds nothing when none of the flags is given', async () => {
	await runCli({ argv: argv() })
	const ctx = launchTui.mock.calls[0]?.[0]
	expect(ctx).not.toHaveProperty('appendSystem')
	expect(ctx?.launchSettings?.fallbackModels).toBeUndefined()
})

it('reads an appended-instructions file before the screen opens, and refuses one it cannot read', async () => {
	const file = join(process.cwd(), 'extra.md')
	writeFileSync(file, 'From a file.\n')
	await runCli({ argv: argv('--append-system-prompt', '@extra.md') })
	expect(launchTui.mock.calls[0]?.[0].appendSystem).toBe('From a file.')

	launchTui.mockClear()
	await expect(runCli({ argv: argv('--append-system-prompt', '@gone.md') })).resolves.toBe(64)
	expect(stderr).toContain('--append-system-prompt could not read')
	expect(launchTui).not.toHaveBeenCalled()
})

it('refuses a tool list with an unclosed bracket instead of dropping it', async () => {
	await expect(runCli({ argv: argv('--allowed-tools', 'bash(git status') })).resolves.toBe(64)
	expect(stderr).toContain('--allowed-tools')
	expect(launchTui).not.toHaveBeenCalled()
})

it('sends a spend limit to the command that can honour it', async () => {
	await expect(runCli({ argv: argv('--max-budget-usd', '2') })).resolves.toBe(64)
	expect(flat(stderr)).toContain('namzu exec --max-budget-usd <amount>')
	expect(launchTui).not.toHaveBeenCalled()
	stderr = ''
	await expect(runCli({ argv: argv('--max-budget-usd', '2', 'exec', 'hi') })).resolves.toBe(64)
	expect(flat(stderr)).toContain('namzu exec --max-budget-usd <value> "<prompt>"')
})

it('points the per-run flags at their place after exec', async () => {
	await expect(
		runCli({ argv: argv('--append-system-prompt', 'x', '--fallback-model', 'y', 'exec', 'hi') }),
	).resolves.toBe(64)
	expect(flat(stderr)).toContain('--append-system-prompt, --fallback-model before the command')
})

it('does not point drain at flags it does not take', async () => {
	await expect(runCli({ argv: argv('--allowed-tools', 'edit', 'drain') })).resolves.toBe(64)
	expect(flat(stderr)).toContain(
		'--allowed-tools apply to the interactive TUI, not this subcommand',
	)
})
