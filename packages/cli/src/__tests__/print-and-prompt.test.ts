import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { TuiContext } from '../tui/types.js'

const launchTui = vi.hoisted(() => vi.fn(async (_ctx: TuiContext) => {}))
const execHandler = vi.hoisted(() => vi.fn(async (_ctx: { rawArgs?: readonly string[] }) => 0))
vi.mock('../tui/index.js', () => ({ launchTui }))
vi.mock('../commands/exec.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('../commands/exec.js')>()
	return { ...original, execCommand: { ...original.execCommand, handler: execHandler } }
})
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
	const root = mkdtempSync(join(tmpdir(), 'namzu-print-prompt-'))
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
	execHandler.mockClear()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
	else Reflect.deleteProperty(process.stdout, 'isTTY')
	for (const root of roots.splice(0)) removeTempDir(root)
})

const flat = (text: string) => text.replace(/\s+/g, ' ')
const argv = (...args: string[]) => ['node', 'namzu', ...args]
const firstMessage = () => launchTui.mock.calls[0]?.[0].launchSettings?.message

it('sends a positional prompt as the first message of the session', async () => {
	await expect(runCli({ argv: argv('fix the failing test') })).resolves.toBe(0)
	expect(firstMessage()).toBe('fix the failing test')
})

it('keeps a slash at the start of the prompt as text and takes options around it', async () => {
	await runCli({ argv: argv('--model', 'm', '/help me', '--effort', 'high') })
	expect(firstMessage()).toBe('/help me')
})

it('reads the text after -- as the prompt, even when it begins with a dash or names a command', async () => {
	await runCli({ argv: argv('--', '--rm -rf: test') })
	expect(firstMessage()).toBe('--rm -rf: test')
	launchTui.mockClear()
	await runCli({ argv: argv('--', 'providers') })
	expect(firstMessage()).toBe('providers')
})

it('still takes the hidden --message of an installed build', async () => {
	await runCli({ argv: argv('--message=hello there') })
	expect(firstMessage()).toBe('hello there')
	expect(stderr).toBe('')
})

it('refuses a prompt given twice', async () => {
	await expect(runCli({ argv: argv('--message', 'a', 'b') })).resolves.toBe(64)
	expect(launchTui).not.toHaveBeenCalled()
})

it('lets a subcommand name win over a prompt', async () => {
	await expect(runCli({ argv: argv('providers', 'list', '--json') })).resolves.not.toBe(64)
	expect(launchTui).not.toHaveBeenCalled()
})

it('says what replaced a retired command typed as the prompt', async () => {
	await expect(runCli({ argv: argv('skills-json') })).resolves.toBe(64)
	expect(flat(stderr)).toContain('namzu skills list --json')
	expect(launchTui).not.toHaveBeenCalled()
})

it('runs the exec handler for -p with the options and the prompt as written', async () => {
	await expect(
		runCli({
			argv: argv(
				'-p',
				'--output-format',
				'stream-json',
				'--max-budget-usd',
				'2',
				'-c',
				'--model',
				'm',
				'--permission-mode',
				'plan',
				'do it',
			),
		}),
	).resolves.toBe(0)
	expect(launchTui).not.toHaveBeenCalled()
	expect(execHandler).toHaveBeenCalledTimes(1)
	expect(execHandler.mock.calls[0]?.[0].rawArgs).toEqual([
		'-p',
		'--output-format',
		'stream-json',
		'--max-budget-usd',
		'2',
		'-c',
		'--model',
		'm',
		'--permission-mode',
		'plan',
		'do it',
	])
})

it('keeps the output controls on the root and hands exec a prompt that begins with a dash', async () => {
	await runCli({ argv: argv('-q', '-p', '--', '-x') })
	expect(execHandler.mock.calls[0]?.[0].rawArgs).toEqual(['-p', '--', '-x'])
})

it('leaves -p after a subcommand name to that command', async () => {
	await runCli({ argv: argv('exec', '-p', 'hi') })
	expect(execHandler.mock.calls[0]?.[0].rawArgs).toEqual(['-p', 'hi'])
})

it('refuses the print-only options without -p, in one line', async () => {
	for (const [flag, value] of [
		['--output-format', 'json'],
		['--input-format', 'stream-json'],
		['--max-budget-usd', '2'],
	] as const) {
		stderr = ''
		await expect(runCli({ argv: argv(flag, value, 'hi') })).resolves.toBe(64)
		expect(flat(stderr)).toContain(`${flag} needs -p`)
		expect(launchTui).not.toHaveBeenCalled()
		expect(execHandler).not.toHaveBeenCalled()
	}
})
