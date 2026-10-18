import { afterEach, describe, expect, it, vi } from 'vitest'

import { BashTool } from '../builtins/bash.js'
import {
	type CommandShell,
	type CommandShellProbe,
	WINDOWS_BASH_GUIDANCE,
	WINDOWS_CMD_FALLBACK_NOTICE,
	findCommandShell,
	findGitBash,
	hostShellSpawn,
	rewriteWindowsNullRedirect,
	setHostCommandShellForTesting,
	spawnHostShell,
	windowsShellNotice,
} from '../command-shell.js'

const PF_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const PF86_BASH = 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'

/** A Windows host: which files exist and what `where.exe git` prints are injected. */
function windows(options: {
	files?: readonly string[]
	where?: readonly string[] | Error
	env?: NodeJS.ProcessEnv
	cwd?: string
}): CommandShellProbe {
	const files = new Set((options.files ?? []).map((f) => f.toLowerCase()))
	return {
		platform: 'win32',
		env: options.env ?? {
			ProgramFiles: 'C:\\Program Files',
			'ProgramFiles(x86)': 'C:\\Program Files (x86)',
		},
		cwd: options.cwd ?? 'C:\\work\\repo',
		isExecutable: (path) => files.has(path.toLowerCase()),
		whereGit: () => {
			if (options.where instanceof Error) throw options.where
			return options.where ?? []
		},
	}
}

afterEach(() => setHostCommandShellForTesting(undefined))

describe('finding Git Bash on Windows', () => {
	it('prefers the override, then Program Files, then Program Files (x86)', () => {
		const probe = windows({ files: [PF_BASH, PF86_BASH, 'D:\\tools\\bash.exe'] })
		expect(findGitBash(probe)).toBe(PF_BASH)
		expect(findGitBash(windows({ files: [PF86_BASH] }))).toBe(PF86_BASH)
		const override = findCommandShell({
			...probe,
			env: { ...probe.env, NAMZU_BASH_SHELL: 'D:\\tools\\bash.exe' },
		})
		expect(override).toEqual({
			path: 'D:\\tools\\bash.exe',
			dialect: 'bash',
			source: 'override',
			windows: true,
		})
	})

	it('finds a per-user install after the Program Files ones, and skips it without LOCALAPPDATA', () => {
		const user = 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'
		const env = { localappdata: 'C:\\Users\\Ada\\AppData\\Local' }
		expect(findGitBash(windows({ files: [user], env }))).toBe(user)
		expect(
			findGitBash(
				windows({
					files: [user, PF86_BASH],
					env: {
						...env,
						ProgramFiles: 'C:\\Program Files',
						'ProgramFiles(x86)': 'C:\\Program Files (x86)',
					},
				}),
			),
		).toBe(PF86_BASH)
		expect(findGitBash(windows({ files: [user] }))).toBeUndefined()
	})

	it('reads the install directories from the environment, not only the usual ones', () => {
		const probe = windows({
			files: ['E:\\Apps\\Git\\bin\\bash.exe'],
			env: { programfiles: 'E:\\Apps' },
		})
		expect(findGitBash(probe)).toBe('E:\\Apps\\Git\\bin\\bash.exe')
	})

	it('falls back to the install that holds the git on PATH', () => {
		const probe = windows({
			files: ['D:\\Dev\\Git\\bin\\bash.exe'],
			where: ['D:\\Dev\\Git\\cmd\\git.exe', 'C:\\other\\git.exe'],
		})
		expect(findGitBash(probe)).toBe('D:\\Dev\\Git\\bin\\bash.exe')
		// <Git>\mingw64\bin\git.exe sits two directories below <Git>\bin.
		expect(
			findGitBash(
				windows({
					files: ['D:\\Dev\\Git\\bin\\bash.exe'],
					where: ['D:\\Dev\\Git\\mingw64\\bin\\git.exe'],
				}),
			),
		).toBe('D:\\Dev\\Git\\bin\\bash.exe')
	})

	it('never trusts a git.exe found inside the working directory', () => {
		const planted = 'C:\\work\\repo\\Git\\cmd\\git.exe'
		const probe = windows({
			files: ['C:\\work\\repo\\Git\\bin\\bash.exe'],
			where: [planted],
		})
		expect(findGitBash(probe)).toBeUndefined()
		// A later hit outside the directory is still used.
		expect(
			findGitBash(
				windows({
					files: ['C:\\work\\repo\\Git\\bin\\bash.exe', 'D:\\Dev\\Git\\bin\\bash.exe'],
					where: [planted, 'D:\\Dev\\Git\\cmd\\git.exe'],
				}),
			),
		).toBe('D:\\Dev\\Git\\bin\\bash.exe')
		// A directory that merely shares a prefix with the working directory is outside it.
		expect(
			findGitBash(
				windows({
					files: ['C:\\work\\repo-tools\\Git\\bin\\bash.exe'],
					where: ['C:\\work\\repo-tools\\Git\\cmd\\git.exe'],
				}),
			),
		).toBe('C:\\work\\repo-tools\\Git\\bin\\bash.exe')
	})

	it('survives CRLF output, blank lines, relative hits and a where.exe that fails', () => {
		const files = ['D:\\Dev\\Git\\bin\\bash.exe']
		expect(
			findGitBash(windows({ files, where: ['', 'git.exe', 'D:\\Dev\\Git\\cmd\\git.exe\r'] })),
		).toBe('D:\\Dev\\Git\\bin\\bash.exe')
		expect(findGitBash(windows({ files, where: new Error('INFO: Could not find files') }))).toBe(
			undefined,
		)
	})

	it('resolves Git Bash as a bash-dialect Windows shell, and cmd when there is none', () => {
		expect(findCommandShell(windows({ files: [PF_BASH] }))).toEqual({
			path: PF_BASH,
			dialect: 'bash',
			source: 'bash',
			windows: true,
		})
		expect(findCommandShell(windows({ files: [] }))).toEqual({
			path: undefined,
			dialect: 'cmd',
			source: 'platform',
		})
	})

	it('keeps cmd when NAMZU_BASH_SHELL names it, even with Git Bash installed', () => {
		for (const name of ['cmd', 'CMD.EXE', 'C:\\Windows\\System32\\cmd.exe']) {
			const probe = windows({ files: [PF_BASH], env: { NAMZU_BASH_SHELL: name } })
			expect(findCommandShell(probe)).toEqual({
				path: undefined,
				dialect: 'cmd',
				source: 'override',
			})
		}
	})
})

describe('the notice', () => {
	it('is said only when a Windows host fell back to cmd', () => {
		const cmd = findCommandShell(windows({ files: [] }))
		expect(windowsShellNotice(cmd)).toBe(WINDOWS_CMD_FALLBACK_NOTICE)
		expect(WINDOWS_CMD_FALLBACK_NOTICE).toBe(
			'Git for Windows not found — shell commands run in cmd.exe and each one asks for approval. Install Git for Windows for full support.',
		)
		expect(windowsShellNotice(findCommandShell(windows({ files: [PF_BASH] })))).toBeUndefined()
		// An operator who asked for cmd was told nothing is missing.
		const chosen = findCommandShell(windows({ files: [PF_BASH], env: { NAMZU_BASH_SHELL: 'cmd' } }))
		expect(windowsShellNotice(chosen)).toBeUndefined()
		expect(
			windowsShellNotice({ path: '/bin/bash', dialect: 'bash', source: 'bash' }),
		).toBeUndefined()
	})
})

describe('the null device', () => {
	it.each([
		['dir >nul', 'dir >/dev/null'],
		['dir > NUL', 'dir > /dev/null'],
		['dir 2>nul', 'dir 2>/dev/null'],
		['dir 2>NUL && echo ok', 'dir 2>/dev/null && echo ok'],
		['dir >nul 2>&1', 'dir >/dev/null 2>&1'],
		['dir &>nul', 'dir &>/dev/null'],
		['(dir >nul)', '(dir >/dev/null)'],
		['dir >>nul', 'dir >>/dev/null'],
	])('rewrites %s', (before, after) => {
		expect(rewriteWindowsNullRedirect(before)).toBe(after)
	})

	it.each([
		'echo nul',
		'dir >null.txt',
		'dir >nulled',
		'cat <<EOF\ndir >nul\nEOF',
		'echo "$HOME" >nul',
		'echo `date` >nul',
	])('leaves %j alone', (command) => {
		expect(rewriteWindowsNullRedirect(command)).toBe(command)
	})

	it('reaches the permission reading and the spawn as the same text', () => {
		setHostCommandShellForTesting(findCommandShell(windows({ files: [PF_BASH] })))
		const parsed = BashTool.inputSchema.parse({ command: 'git status 2>nul' }) as {
			command: string
		}
		expect(parsed.command).toBe('git status 2>/dev/null')
		setHostCommandShellForTesting({ path: undefined, dialect: 'cmd', source: 'platform' })
		expect(BashTool.inputSchema.parse({ command: 'dir 2>nul' })).toMatchObject({
			command: 'dir 2>nul',
		})
	})
})

describe('the spawn', () => {
	const shell: CommandShell = findCommandShell(windows({ files: [PF_BASH] }))

	it('runs bash -c with git kept from opening an editor and no bash startup variables', () => {
		const spawned = hostShellSpawn(
			'git commit 2>nul',
			{ A: '1', BASH_ENV: 'x', GIT_EDITOR: 'vim' },
			shell,
		)
		expect(spawned.file).toBe(PF_BASH)
		expect(spawned.args).toEqual(['-c', 'git commit 2>/dev/null'])
		expect(spawned.env).toEqual({ A: '1', GIT_EDITOR: 'true' })
	})

	it('spawns hidden, not detached, with no input to wait for', () => {
		const spawnImpl = vi.fn(() => ({}) as never)
		spawnHostShell('ls', { cwd: 'C:\\work', env: {}, shell, platform: 'win32', spawnImpl })
		expect(spawnImpl).toHaveBeenCalledWith(PF_BASH, ['-c', 'ls'], {
			cwd: 'C:\\work',
			// The tag is how a kill finds what the command forked.
			env: { GIT_EDITOR: 'true', NAMZU_SHELL_TAG: expect.stringMatching(/^[0-9a-f-]{36}$/) },
			detached: false,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		})
	})

	it('leaves a caller-chosen stdio alone (a hook writes its payload to stdin)', () => {
		const spawnImpl = vi.fn(() => ({}) as never)
		spawnHostShell('cat', {
			cwd: 'C:\\work',
			env: {},
			shell,
			platform: 'win32',
			stdio: ['pipe', 'pipe', 'pipe'],
			spawnImpl,
		})
		const call = spawnImpl.mock.calls[0] as unknown as [string, string[], { stdio: unknown }]
		expect(call[2].stdio).toEqual(['pipe', 'pipe', 'pipe'])
	})

	it('does not change the POSIX spawn', () => {
		const posix: CommandShell = { path: '/usr/bin/bash', dialect: 'bash', source: 'bash' }
		expect(hostShellSpawn('ls 2>nul', { A: '1' }, posix)).toEqual({
			file: '/usr/bin/bash',
			args: ['-c', 'ls 2>nul'],
			env: { A: '1' },
		})
	})
})

describe('what the model is told', () => {
	it('adds the syntax rules to the tool description on Windows only', () => {
		setHostCommandShellForTesting(findCommandShell(windows({ files: [PF_BASH] })))
		expect(BashTool.description).toContain(WINDOWS_BASH_GUIDANCE)
		expect(WINDOWS_BASH_GUIDANCE).toContain(
			'This tool runs Git Bash (POSIX sh), not cmd.exe or PowerShell.',
		)
		expect(WINDOWS_BASH_GUIDANCE).toContain('`/dev/null` not `NUL`')
		expect(WINDOWS_BASH_GUIDANCE).toContain('powershell -NoProfile -Command')
		setHostCommandShellForTesting({ path: '/bin/bash', dialect: 'bash', source: 'bash' })
		expect(BashTool.description).not.toContain('Git Bash')
		setHostCommandShellForTesting({ path: undefined, dialect: 'cmd', source: 'platform' })
		expect(BashTool.description).not.toContain('Git Bash')
	})
})
