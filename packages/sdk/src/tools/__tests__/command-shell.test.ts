import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthorizationGate } from '../../authorization/gate.js'
import { BackgroundJobRegistry } from '../../runtime/jobs/registry.js'
import type { Sandbox, SandboxExecOptions } from '../../types/sandbox/index.js'
import type { ToolContext } from '../../types/tool/index.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { BashTool } from '../builtins/bash.js'
import {
	type CommandShell,
	type CommandShellProbe,
	SANDBOX_SHELL_LAUNCHER,
	findCommandShell,
	hostCommandShell,
	hostShellSpawn,
	sandboxShellSpawn,
	setHostCommandShellForTesting,
	withoutBashStartup,
} from '../command-shell.js'

/**
 * The `bash` tool runs bash, and the permission rules read its command line
 * in the dialect of the shell it actually spawns. These tests hold the two to
 * each other: resolution, the argv spawned, the environment, and the dialect
 * the gate and the tool report for the same host.
 */

function probe(executables: readonly string[], env: NodeJS.ProcessEnv = {}): CommandShellProbe {
	return {
		env: { PATH: '/opt/tools:/usr/local/bin:/usr/bin', ...env },
		platform: 'linux',
		isExecutable: (path) => executables.includes(path),
	}
}

const NO_BASH: CommandShell = { path: '/bin/sh', dialect: 'sh', source: 'sh' }
const hasBash = process.platform !== 'win32' && hostCommandShell().dialect === 'bash'

afterEach(() => {
	setHostCommandShellForTesting(undefined)
})

describe('resolution', () => {
	it('takes the first bash on PATH', () => {
		expect(findCommandShell(probe(['/usr/local/bin/bash', '/usr/bin/bash']))).toEqual({
			path: '/usr/local/bin/bash',
			dialect: 'bash',
			source: 'bash',
		})
	})

	it('falls back to the well-known paths, then to /bin/sh read as sh', () => {
		expect(findCommandShell(probe(['/bin/bash'], { PATH: '/nowhere' })).path).toBe('/bin/bash')
		expect(findCommandShell(probe([], { PATH: '/nowhere' }))).toEqual(NO_BASH)
	})

	it('ignores a relative PATH entry, which would resolve against the cwd', () => {
		expect(findCommandShell(probe(['bin/bash'], { PATH: 'bin' }))).toEqual(NO_BASH)
	})

	it('honours NAMZU_BASH_SHELL and reads it as bash only when it is bash', () => {
		expect(findCommandShell(probe(['/usr/bin/bash'], { NAMZU_BASH_SHELL: '/bin/sh' }))).toEqual({
			path: '/bin/sh',
			dialect: 'sh',
			source: 'override',
		})
		expect(findCommandShell(probe([], { NAMZU_BASH_SHELL: '/opt/bash' })).dialect).toBe('bash')
	})

	it('keeps the platform shell on Windows', () => {
		expect(findCommandShell({ ...probe(['/usr/bin/bash']), platform: 'win32' })).toEqual({
			path: undefined,
			dialect: 'sh',
			source: 'platform',
		})
	})
})

describe('the spawn', () => {
	it('runs bash -c without the variables that change what the line means', () => {
		const shell: CommandShell = { path: '/usr/bin/bash', dialect: 'bash', source: 'bash' }
		const spawned = hostShellSpawn(
			'git status',
			{
				PATH: '/usr/bin',
				BASH_ENV: '/tmp/x',
				ENV: '/tmp/y',
				SHELLOPTS: 'posix',
				BASHOPTS: 'extglob',
				'BASH_FUNC_git%%': '() { :; }',
				KEEP: '1',
			},
			shell,
		)
		expect(spawned.file).toBe('/usr/bin/bash')
		expect(spawned.args).toEqual(['-c', 'git status'])
		expect(spawned.env).toEqual({ PATH: '/usr/bin', KEEP: '1' })
	})

	it('runs /bin/sh -c with the environment untouched where there is no bash', () => {
		const spawned = hostShellSpawn('git status', { BASH_ENV: '/tmp/x' }, NO_BASH)
		expect(spawned).toEqual({
			file: '/bin/sh',
			args: ['-c', 'git status'],
			env: { BASH_ENV: '/tmp/x' },
		})
	})

	it('passes a sandboxed command as an argument to the launcher, never inside its text', () => {
		expect(sandboxShellSpawn("echo '; rm -rf ~'")).toEqual({
			file: '/bin/sh',
			args: ['-c', SANDBOX_SHELL_LAUNCHER, 'sh', "echo '; rm -rf ~'"],
		})
		expect(withoutBashStartup({ BASH_ENV: 'x', A: 'b' })).toEqual({ A: 'b' })
	})

	it.skipIf(!existsSync('/bin/sh') || process.platform === 'win32')(
		'the launcher runs bash when the guest has it, and /bin/sh when it does not',
		() => {
			const { file, args } = sandboxShellSpawn('echo "$0"')
			const run = (path: string): string =>
				execFileSync(file, args, { env: { PATH: path }, encoding: 'utf8' }).trim()
			const empty = mkdtempSync(join(tmpdir(), 'namzu-no-bash-'))
			try {
				expect(run(empty)).toBe('/bin/sh')
				if (hasBash) expect(run(process.env.PATH ?? '')).toBe('bash')
			} finally {
				rmSync(empty, { recursive: true, force: true })
			}
		},
	)
})

function hostContext(env: Record<string, string> = {}): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b',
		turnId: '37ddff8e-e13f-4e57-937f-d048fa323f5e',
		workingDirectory: tmpdir(),
		abortSignal: new AbortController().signal,
		env,
		log: () => {},
	} as unknown as ToolContext
}

describe('the bash tool', () => {
	it.skipIf(!hasBash)('spawns bash on a host that has it', async () => {
		const result = await BashTool.execute(
			{ command: 'echo "$0:${BASH_VERSION:+bash}"', timeout: 10_000 },
			hostContext(),
		)
		expect(result.output).toContain(`${hostCommandShell().path}:bash`)
	})

	it.skipIf(!hasBash)('does not source BASH_ENV or import functions', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-bash-env-'))
		try {
			const startup = join(dir, 'startup.sh')
			writeFileSync(startup, 'echo SOURCED\n')
			const result = await BashTool.execute(
				{ command: 'git 2>/dev/null; echo done', timeout: 10_000 },
				hostContext({ BASH_ENV: startup, 'BASH_FUNC_git%%': '() { echo FUNCTION; }' }),
			)
			expect(result.output).toContain('done')
			expect(result.output).not.toContain('SOURCED')
			expect(result.output).not.toContain('FUNCTION')
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it.skipIf(!existsSync('/bin/sh') || process.platform === 'win32')(
		'spawns /bin/sh where the host has no bash',
		async () => {
			setHostCommandShellForTesting(NO_BASH)
			const result = await BashTool.execute(
				{ command: 'echo "$0"', timeout: 10_000 },
				hostContext(),
			)
			expect(result.output).toContain('/bin/sh')
		},
	)

	it('runs a sandboxed command through the launcher', async () => {
		const exec = vi.fn(
			async (_command: string, _args?: string[], _options?: SandboxExecOptions) => ({
				stdout: 'ok',
				stderr: '',
				exitCode: 0,
				timedOut: false,
				durationMs: 1,
			}),
		)
		const sandbox = { exec } as unknown as Sandbox
		await BashTool.execute(
			{ command: 'git status', timeout: 1000 },
			{ ...hostContext({ BASH_ENV: '/x', KEEP: '1' }), sandbox },
		)
		const launch = sandboxShellSpawn('git status')
		expect(exec).toHaveBeenCalledWith(
			launch.file,
			launch.args,
			expect.objectContaining({ env: { KEEP: '1' } }),
		)
	})

	it('reports the dialect of the shell it will spawn', () => {
		setHostCommandShellForTesting({ path: '/usr/bin/bash', dialect: 'bash', source: 'bash' })
		expect(BashTool.commandDialect?.({ sandboxed: false })).toBe('bash')
		// A guest may lack bash, so a sandboxed line is read for either shell.
		expect(BashTool.commandDialect?.({ sandboxed: true })).toBe('sh')
		setHostCommandShellForTesting(NO_BASH)
		expect(BashTool.commandDialect?.({ sandboxed: false })).toBe('sh')
	})
})

describe('the rules read the line for the shell that runs it', () => {
	const gate = new AuthorizationGate(
		{
			enabled: true,
			rules: [
				{
					type: 'argument_pattern',
					toolNames: ['bash'],
					argument: 'command',
					pattern: '^git status',
					decision: 'allow',
				},
			],
			allowReadOnlyTools: false,
			denyDangerousPatterns: false,
			logDecisions: false,
		} as ConstructorParameters<typeof AuthorizationGate>[0],
		NOOP_LOGGER,
	)
	const evaluate = (command: string, sandboxed: boolean) =>
		gate.evaluate({
			toolName: 'bash',
			toolInput: { command },
			toolDef: BashTool,
			...(BashTool.commandDialect
				? { commandDialect: BashTool.commandDialect({ sandboxed }) }
				: {}),
		}).decision

	it('allows `&>` on a host that runs bash, and not where /bin/sh may be dash', () => {
		// dash reads `git status &>/dev/null` as `git status &` then `>/dev/null`.
		setHostCommandShellForTesting({ path: '/usr/bin/bash', dialect: 'bash', source: 'bash' })
		expect(evaluate('git status &>/dev/null', false)).toBe('allow')
		expect(evaluate('git status &>/dev/null', true)).not.toBe('allow')
		setHostCommandShellForTesting(NO_BASH)
		expect(evaluate('git status &>/dev/null', false)).not.toBe('allow')
		expect(evaluate('git status 2>/dev/null', false)).toBe('allow')
	})

	it('reads a line for any POSIX shell when the caller does not say which', () => {
		expect(
			gate.evaluate({
				toolName: 'bash',
				toolInput: { command: "git status $'-s'" },
				toolDef: undefined,
			}).decision,
		).not.toBe('allow')
	})
})

describe('background jobs', () => {
	it.skipIf(!existsSync('/bin/sh') || process.platform === 'win32')(
		'run on the host in the same shell as a foreground call',
		async () => {
			setHostCommandShellForTesting(NO_BASH)
			const registry = new BackgroundJobRegistry()
			const job = registry.start({ owner: 'o', command: 'echo "$0"', workingDirectory: tmpdir() })
			await registry.waitForExit(job.id)
			expect(registry.read(job.id).chunk).toContain('/bin/sh')
		},
	)
})
