import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	BARE_SETTINGS,
	resolveSystemPromptFlag,
	resolveToolsFlag,
} from '../commands/launch-extras.js'
import { composeSessionSystemPrompt, sessionPromptInput } from '../context/system-prompt.js'
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
let cwd = ''

beforeEach(() => {
	stderr = ''
	writeStderr = process.stderr.write.bind(process.stderr)
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
		return true
	}) as typeof process.stderr.write
	const root = mkdtempSync(join(tmpdir(), 'namzu-launch-extras-'))
	roots.push(root)
	const home = join(root, 'home')
	cwd = join(root, 'workspace')
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
const launched = (): TuiContext => {
	const ctx = launchTui.mock.calls[0]?.[0]
	if (!ctx) throw new Error('the terminal session was not launched')
	return ctx
}

it('replaces the system prompt for the launch, from text or a file', async () => {
	await runCli({ argv: argv('--system-prompt', 'You are terse.') })
	expect(launched().replaceSystem).toBe('You are terse.')
	launchTui.mockClear()
	writeFileSync(join(cwd, 'sys.md'), 'From a file.\n')
	await runCli({ argv: argv('--system-prompt', '@sys.md') })
	expect(launched().replaceSystem).toBe('From a file.')
	launchTui.mockClear()
	await expect(runCli({ argv: argv('--system-prompt', '@gone.md') })).resolves.toBe(64)
	expect(stderr).toContain('--system-prompt could not read')
	expect(launchTui).not.toHaveBeenCalled()
})

it('offers only the named tools, none for an empty list, all for default', async () => {
	await runCli({ argv: argv('--tools', 'Read, edit bash') })
	expect(launched().onlyTools).toEqual(['read', 'edit', 'bash'])
	launchTui.mockClear()
	await runCli({ argv: argv('--tools', '') })
	expect(launched().onlyTools).toEqual([])
	launchTui.mockClear()
	await runCli({ argv: argv('--tools', 'default') })
	expect(launched()).not.toHaveProperty('onlyTools')
	launchTui.mockClear()
	await runCli({ argv: argv() })
	expect(launched()).not.toHaveProperty('onlyTools')
	launchTui.mockClear()
	await expect(runCli({ argv: argv('--tools', 'bash(git status*)') })).resolves.toBe(64)
	expect(flat(stderr)).toContain('--tools takes tool names only')
})

it('names the conversation from -n and --name', async () => {
	await runCli({ argv: argv('-n', 'billing fix') })
	expect(launched().launchSettings?.name).toBe('billing fix')
	launchTui.mockClear()
	await runCli({ argv: argv('--name', 'other') })
	expect(launched().launchSettings?.name).toBe('other')
})

it('takes the new flags after resume as it does the others', async () => {
	await runCli({ argv: argv('resume', 'abc', '--tools', '', '--system-prompt', 'x', '--bare') })
	const ctx = launched()
	expect(ctx.onlyTools).toEqual([])
	expect(ctx.replaceSystem).toBe('x')
	expect(ctx.bare).toBe(true)
})

it('turns off, with --bare, what the settings can say and what they cannot', async () => {
	await runCli({ argv: argv('--bare') })
	const ctx = launched()
	expect(ctx.bare).toBe(true)
	expect(ctx.hooksSwitch).toBe('disabled')
	expect(ctx.plugins?.enabled).toBe(false)
	expect(ctx.memory?.recall).toBe(false)
	expect(ctx.learningObservations).toBe(false)
	expect(ctx.learningGenerator).toBe(false)
	expect(ctx.updates).toEqual({ check: false, auto: false })
	expect(ctx.skills?.suggest).toBe(false)
	expect(ctx.codeAnalysis?.enabled).toBe(false)
	// The catalogue refresh is read before a project is trusted, from the same layer.
	expect(BARE_SETTINGS.modelCatalogueRefresh).toBe(false)
	launchTui.mockClear()
	await runCli({ argv: argv() })
	expect(launched()).not.toHaveProperty('bare')
	expect(launched().hooksSwitch).toBeUndefined()
})

it('carries the switch that turns off commands inside skills to the terminal app', async () => {
	await runCli({ argv: argv() })
	expect(launched().skillShellDisabled).toBeUndefined()
	launchTui.mockClear()
	writeFileSync(
		join(process.env.NAMZU_HOME as string, 'config.yaml'),
		'disableSkillShellExecution: true\n',
	)
	await runCli({ argv: argv() })
	expect(launched().skillShellDisabled).toBe(true)
})

it('reads one extra settings layer from inline JSON or a file, above the user file', async () => {
	writeFileSync(
		join(process.env.NAMZU_HOME as string, 'config.yaml'),
		'hypermode: false\nrespectGitignore: true\n',
	)
	await runCli({ argv: argv('--settings', '{"respectGitignore": false}') })
	expect(launched().respectGitignore).toBe(false)
	launchTui.mockClear()
	writeFileSync(join(cwd, 'extra.json'), '{"closingSummary": false}')
	await runCli({ argv: argv('--settings', 'extra.json') })
	expect(launched().closingSummary).toBe(false)
})

it('lets a flag win over the settings layer, and the settings layer win over --bare', async () => {
	await runCli({
		argv: argv('--bare', '--settings', '{"updates": {"check": true}}', '--max-output-tokens', '99'),
	})
	const ctx = launched()
	expect(ctx.updates?.check).toBe(true)
	expect(ctx.limits?.maxResponseTokens).toBe(99)
})

it('refuses invalid JSON, a missing file and an unknown setting in one sentence, exit 64', async () => {
	await expect(runCli({ argv: argv('--settings', '{oops') })).resolves.toBe(64)
	expect(flat(stderr)).toContain('--settings is not valid JSON')
	stderr = ''
	await expect(runCli({ argv: argv('--settings', 'gone.json') })).resolves.toBe(64)
	expect(flat(stderr)).toContain('--settings could not read')
	stderr = ''
	await expect(runCli({ argv: argv('--settings', '{"nonsense": 1}') })).resolves.toBe(64)
	expect(flat(stderr)).toContain('Namzu does not know: nonsense')
	stderr = ''
	writeFileSync(join(cwd, 'list.json'), '[1]')
	await expect(runCli({ argv: argv('--settings', 'list.json') })).resolves.toBe(64)
	expect(flat(stderr)).toContain('must be a set of named settings')
	expect(launchTui).not.toHaveBeenCalled()
})

it('adds the tool servers of --mcp-config, and with --strict-mcp-config uses only those', async () => {
	writeFileSync(
		join(process.env.NAMZU_HOME as string, 'config.yaml'),
		'mcpServers:\n  saved:\n    command: node\n',
	)
	writeFileSync(join(cwd, 'a.json'), '{"mcpServers": {"filed": {"command": "node"}}}')
	await runCli({
		argv: argv(
			'--mcp-config',
			'a.json',
			'--mcp-config',
			'{"mcpServers": {"inline": {"command": "node"}}}',
		),
	})
	expect(Object.keys(launched().mcpServers ?? {}).sort()).toEqual(['filed', 'inline', 'saved'])
	launchTui.mockClear()
	await runCli({ argv: argv('--strict-mcp-config', '--mcp-config', 'a.json') })
	expect(Object.keys(launched().mcpServers ?? {})).toEqual(['filed'])
	launchTui.mockClear()
	await runCli({ argv: argv('--strict-mcp-config') })
	expect(Object.keys(launched().mcpServers ?? {})).toEqual([])
	launchTui.mockClear()
	await expect(runCli({ argv: argv('--mcp-config', 'gone.json') })).resolves.toBe(64)
	expect(stderr).toContain('--mcp-config gone.json: no such file')
	expect(launchTui).not.toHaveBeenCalled()
})

it('sends the new flags after -p to exec, and keeps the process-wide ones on the root', async () => {
	await runCli({
		argv: argv(
			'-p',
			'--system-prompt',
			'x',
			'--tools',
			'',
			'-n',
			'job',
			'--strict-mcp-config',
			'--mcp-config',
			'a.json',
			'--bare',
			'--settings',
			'{"closingSummary": false}',
			'hi',
		),
	})
	const raw = execHandler.mock.calls[0]?.[0].rawArgs ?? []
	expect(raw).toEqual([
		'-p',
		'--system-prompt',
		'x',
		'--tools',
		'',
		'-n',
		'job',
		'--strict-mcp-config',
		'--mcp-config',
		'a.json',
		'hi',
	])
})

it('moves --bare, --settings and --debug-file written after exec in front of it', async () => {
	await runCli({
		argv: argv(
			'exec',
			'--bare',
			'--settings',
			'{"closingSummary": false}',
			'--debug-file=d.log',
			'hi',
			'--tools',
			'read',
		),
	})
	expect(execHandler.mock.calls[0]?.[0].rawArgs).toEqual(['hi', '--tools', 'read'])
	// A prompt after -- is left alone.
	execHandler.mockClear()
	await runCli({ argv: argv('exec', '--', '--bare') })
	// The prompt, not a flag: it reaches exec untouched.
	expect(execHandler.mock.calls[0]?.[0].rawArgs).toEqual(['--bare'])
})

it('writes debug-level records to --debug-file and makes the folders of the path', async () => {
	const file = join(cwd, 'logs', 'deep', 'debug.log')
	await expect(runCli({ argv: argv('--debug-file', file, 'providers', 'list') })).resolves.toBe(0)
	expect(existsSync(file)).toBe(true)
	const lines = readFileSync(file, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line))
	expect(lines.length).toBeGreaterThan(0)
	expect(lines.some((line) => line.severityText === 'debug')).toBe(true)
	const { __closeDebugFileForTests } = await import('../logging.js')
	__closeDebugFileForTests()
	// A path that cannot be opened is refused before anything runs.
	stderr = ''
	await expect(runCli({ argv: argv('--debug-file', cwd, 'providers', 'list') })).resolves.toBe(64)
	expect(flat(stderr)).toContain('--debug-file could not open')
})

it('says --tools and --system-prompt before a subcommand belong after exec', async () => {
	await expect(runCli({ argv: argv('--tools', 'read', 'exec', 'hi') })).resolves.toBe(64)
	expect(flat(stderr)).toContain('--tools before the command')
})

it('reads the tools list and the system prompt flag values', () => {
	expect(resolveToolsFlag(null)).toEqual({ only: undefined })
	expect(resolveToolsFlag('')).toEqual({ only: [] })
	expect(resolveToolsFlag('default')).toEqual({ only: undefined })
	expect(resolveToolsFlag('Bash,mcp__Files__Read Edit')).toEqual({
		only: ['bash', 'mcp__Files__Read', 'edit'],
	})
	expect(resolveToolsFlag('default read')).toHaveProperty('error')
	expect(resolveSystemPromptFlag('   ')).toEqual({ error: '--system-prompt is empty' })
	expect(resolveSystemPromptFlag(null)).toBeUndefined()
})

it('puts the replacement text where the default sections were, keeping the turn’s own notes', () => {
	const input = sessionPromptInput(
		{ anyToolDeferred: false, systemOverride: 'Only this.', environment: 'ENV' },
		{ extraSystem: 'mode note' },
	)
	const text = composeSessionSystemPrompt(input) ?? ''
	expect(text).toBe('Only this.\n\nmode note')
	const normal = composeSessionSystemPrompt(
		sessionPromptInput({ anyToolDeferred: false, environment: 'ENV' }, {}),
	)
	expect(normal).toContain('ENV')
})

it('stops offering delegation when --tools leaves out the agent tool', () => {
	const withIt = composeSessionSystemPrompt(
		sessionPromptInput({ anyToolDeferred: false, onlyTools: ['agent', 'read'] }, {}),
	)
	const without = composeSessionSystemPrompt(
		sessionPromptInput({ anyToolDeferred: false, onlyTools: ['read'] }, {}),
	)
	expect((withIt ?? '').length).toBeGreaterThan((without ?? '').length)
})
