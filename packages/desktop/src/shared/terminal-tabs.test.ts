import { describe, expect, it } from 'vitest'
import {
	ACTIVITY_IDLE_MS,
	ACTIVITY_WORKING_MS,
	type EngineHost,
	PROMPT_NOT_PASSED,
	availableShells,
	buildEngineLaunch,
	codexPermissionArgs,
	findWindowsProgram,
	isTerminalTabId,
	resolveShell,
	secondEnginePermissionArgument,
	terminalActivity,
	terminalHostId,
	terminalTabId,
	terminalTitle,
} from './terminal-tabs.js'

const HOST = '0f0e0d0c-0b0a-4908-8706-050403020100'

describe('terminal tab ids', () => {
	it('round-trips a host id and refuses anything else', () => {
		expect(terminalTabId(HOST)).toBe(`terminal-${HOST}`)
		expect(isTerminalTabId(`terminal-${HOST}`)).toBe(true)
		expect(terminalHostId(`terminal-${HOST}`)).toBe(HOST)
		for (const bad of ['', HOST, 'terminal-', 'terminal-x', `terminal-${HOST}0`, 7, null])
			expect(isTerminalTabId(bad)).toBe(false)
		expect(() => terminalHostId('conversation-1')).toThrow()
	})
})

describe('terminalActivity', () => {
	const now = 1_000_000
	it('is working while output is recent, waiting after it stops, idle after a minute', () => {
		const at = (ago: number) =>
			terminalActivity({ status: 'running', lastOutputAt: now - ago, now })
		expect(at(0)).toBe('working')
		expect(at(ACTIVITY_WORKING_MS - 1)).toBe('working')
		expect(at(ACTIVITY_WORKING_MS)).toBe('waiting')
		expect(at(ACTIVITY_IDLE_MS - 1)).toBe('waiting')
		expect(at(ACTIVITY_IDLE_MS)).toBe('idle')
	})
	it('is working before the first byte and exited for any ended tab', () => {
		expect(terminalActivity({ status: 'running', lastOutputAt: undefined, now })).toBe('working')
		expect(terminalActivity({ status: 'exited', lastOutputAt: now, now })).toBe('exited')
		expect(terminalActivity({ status: 'restored', lastOutputAt: undefined, now })).toBe('exited')
	})
})

describe('terminalTitle', () => {
	it('names an engine tab by engine and project and a shell tab by its shell', () => {
		expect(terminalTitle({ kind: 'engine', engine: 'codex-cli', projectName: 'api' })).toBe(
			'Codex CLI · api',
		)
		expect(terminalTitle({ kind: 'shell', projectName: 'api', shell: 'zsh' })).toBe('zsh')
		expect(terminalTitle({ kind: 'shell', projectName: 'api' })).toBe('Terminal')
	})
})

describe('shell choice', () => {
	const windows = (programs: Record<string, string>, env: Record<string, string> = {}) => ({
		platform: 'win32' as const,
		env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', ...env },
		find: (name: string) => programs[name],
	})
	const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
	const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

	it('uses the login shell elsewhere than Windows', () => {
		const posix = (env: Record<string, string>, platform: NodeJS.Platform = 'linux') => ({
			platform,
			env,
			find: () => undefined,
		})
		expect(resolveShell('auto', posix({ SHELL: '/usr/bin/fish' }))).toMatchObject({
			command: '/usr/bin/fish',
			title: 'fish',
		})
		expect(resolveShell('auto', posix({}))).toMatchObject({ command: '/bin/sh' })
		expect(resolveShell('auto', posix({}, 'darwin'))).toMatchObject({ command: '/bin/zsh' })
		expect(resolveShell('pwsh', posix({ SHELL: '/bin/bash' })).command).toBe('/bin/bash')
	})

	it('prefers PowerShell 7 on Windows and never Windows PowerShell by default', () => {
		expect(
			resolveShell('auto', windows({ 'pwsh.exe': PWSH, 'powershell.exe': POWERSHELL })),
		).toEqual({ command: PWSH, args: ['-NoLogo'], title: 'PowerShell' })
		const cmd = resolveShell('auto', windows({ 'powershell.exe': POWERSHELL }))
		expect(cmd).toEqual({
			command: 'C:\\Windows\\System32\\cmd.exe',
			args: ['/d', '/k', 'chcp 65001>nul'],
			title: 'Command Prompt',
		})
	})

	it('honours an explicit choice that is installed and falls back when it is not', () => {
		const all = windows({
			'pwsh.exe': PWSH,
			'powershell.exe': POWERSHELL,
			'wsl.exe': 'C:\\w\\wsl.exe',
		})
		expect(resolveShell('powershell', all).command).toBe(POWERSHELL)
		expect(resolveShell('cmd', all).title).toBe('Command Prompt')
		expect(resolveShell('wsl', all)).toEqual({ command: 'C:\\w\\wsl.exe', args: [], title: 'WSL' })
		expect(resolveShell('wsl', windows({})).title).toBe('Command Prompt')
		expect(resolveShell('pwsh', windows({ 'powershell.exe': POWERSHELL })).command).toBe(POWERSHELL)
		expect(resolveShell('powershell', windows({ 'pwsh.exe': PWSH })).command).toBe(PWSH)
	})

	it('lists only what the machine offers', () => {
		expect(availableShells({ platform: 'linux', env: {}, find: () => 'x' })).toEqual(['auto'])
		expect(availableShells(windows({}))).toEqual(['auto', 'cmd'])
		expect(
			availableShells(windows({ 'pwsh.exe': PWSH, 'powershell.exe': POWERSHELL, 'wsl.exe': 'w' })),
		).toEqual(['auto', 'pwsh', 'powershell', 'cmd', 'wsl'])
	})
})

const linux: EngineHost = {
	platform: 'linux',
	execPath: '/opt/Namzu/namzu',
	cliEntry: '/opt/Namzu/resources/cli/dist/bin.js',
	nodeArgs: [],
	resolve: (name) => ({ path: `/usr/bin/${name}`, shim: false }),
}
const windows: EngineHost = {
	platform: 'win32',
	execPath: 'C:\\Users\\A B\\AppData\\Local\\Programs\\Namzu\\Namzu.exe',
	cliEntry: 'C:\\Users\\A B\\AppData\\Local\\Programs\\Namzu\\resources\\cli\\dist\\bin.js',
	nodeArgs: ['--use-system-ca'],
	resolve: (name) =>
		name === 'codex'
			? { path: 'C:\\Users\\A\\AppData\\Roaming\\npm\\codex.cmd', shim: true }
			: { path: 'C:\\Users\\A\\.local\\bin\\claude.exe', shim: false },
}

describe('Namzu engine launch', () => {
	it('runs the bundled CLI as Node with every composer choice as a flag', () => {
		expect(
			buildEngineLaunch(
				{
					engine: 'namzu',
					provider: 'openai',
					model: 'gpt-5',
					effort: 'high',
					permissionMode: 'plan',
				},
				linux,
				{ name: 'api' },
			),
		).toEqual({
			command: '/opt/Namzu/namzu',
			args: [
				'/opt/Namzu/resources/cli/dist/bin.js',
				'--provider',
				'openai',
				'--model',
				'gpt-5',
				'--effort',
				'high',
				'--permission-mode',
				'plan',
			],
			env: { ELECTRON_RUN_AS_NODE: '1' },
			title: 'Namzu · api',
			omitted: [],
		})
	})

	it('leaves out what was not chosen but always states the mode', () => {
		const launch = buildEngineLaunch({ engine: 'namzu', permissionMode: 'prompt' }, linux, {
			name: 'api',
		})
		expect(launch.args.slice(1)).toEqual(['--permission-mode', 'prompt'])
	})

	it('goes through Command Prompt on Windows, with the node flags before the entry', () => {
		const launch = buildEngineLaunch(
			{ engine: 'namzu', model: 'm', permissionMode: 'accept-edits' },
			windows,
			{ name: 'api' },
		)
		expect(launch.command).toBe('cmd.exe')
		expect(launch.args).toEqual([
			'/d',
			'/c',
			'call',
			windows.execPath,
			'--use-system-ca',
			windows.cliEntry,
			'--model',
			'm',
			'--permission-mode',
			'accept-edits',
		])
		expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
	})

	it('runs the installed namzu when no CLI is bundled', () => {
		const dev = { ...linux, cliEntry: undefined }
		expect(
			buildEngineLaunch({ engine: 'namzu', permissionMode: 'auto' }, dev, { name: 'p' }),
		).toMatchObject({ command: 'namzu', args: ['--permission-mode', 'auto'] })
		// Command Prompt looks in the project folder first, so a bare name is never run there.
		const win = { ...windows, cliEntry: undefined }
		expect(() =>
			buildEngineLaunch({ engine: 'namzu', permissionMode: 'auto' }, win, { name: 'p' }),
		).toThrow(/bundled Namzu CLI is not available/)
	})

	it('starts Command Prompt by its absolute path when the host knows it', () => {
		const launch = buildEngineLaunch(
			{ engine: 'codex-cli', permissionMode: 'plan' },
			{
				...windows,
				commandPrompt: 'C:\\Windows\\System32\\cmd.exe',
			},
			{ name: 'api' },
		)
		expect(launch.command).toBe('C:\\Windows\\System32\\cmd.exe')
	})

	it('keeps a message that holds a line break or would overrun the line out of the command line', () => {
		for (const prompt of ['one\ntwo', 'one\rtwo', 'hello!', 'x'.repeat(8_000)]) {
			const launch = buildEngineLaunch(
				{ engine: 'codex-cli', permissionMode: 'plan', prompt },
				windows,
				{
					name: 'api',
				},
			)
			expect(launch.omitted).toContain('your message')
			expect(launch.args).not.toContain(prompt)
		}
	})

	it('refuses a value that Command Prompt would read as syntax', () => {
		expect(() =>
			buildEngineLaunch({ engine: 'namzu', model: 'a&calc', permissionMode: 'prompt' }, windows, {
				name: 'p',
			}),
		).toThrow(/Command Prompt/)
		// The same value is only an argument off Windows.
		expect(
			buildEngineLaunch({ engine: 'namzu', model: 'a&calc', permissionMode: 'prompt' }, linux, {
				name: 'p',
			}).args,
		).toContain('a&calc')
	})
})

describe('Codex engine launch', () => {
	it.each([
		['prompt', ['-a', 'on-request', '-s', 'read-only']],
		['accept-edits', ['-a', 'on-request', '-s', 'workspace-write']],
		['auto', ['-a', 'on-request', '-s', 'danger-full-access']],
		['plan', ['-a', 'never', '-s', 'read-only']],
		['strict', ['-a', 'never', '-s', 'read-only']],
	] as const)('maps the %s mode to approval and sandbox flags', (mode, flags) => {
		expect(codexPermissionArgs(mode)).toEqual(flags)
		const launch = buildEngineLaunch({ engine: 'codex-cli', permissionMode: mode }, linux, {
			name: 'api',
		})
		expect(launch.command).toBe('/usr/bin/codex')
		expect(launch.args).toEqual(flags)
		expect(launch.env).toBeUndefined()
	})

	it('passes the model and the reasoning effort as a config override', () => {
		const launch = buildEngineLaunch(
			{ engine: 'codex-cli', model: 'gpt-5-codex', effort: 'xhigh', permissionMode: 'plan' },
			linux,
			{ name: 'api' },
		)
		expect(launch.args).toEqual([
			'-m',
			'gpt-5-codex',
			'-c',
			'model_reasoning_effort=xhigh',
			'-a',
			'never',
			'-s',
			'read-only',
		])
		expect(launch.title).toBe('Codex CLI · api')
	})

	it('names an effort Codex cannot take instead of passing it', () => {
		const launch = buildEngineLaunch(
			{ engine: 'codex-cli', effort: 'max', permissionMode: 'plan' },
			linux,
			{ name: 'api' },
		)
		expect(launch.args.join(' ')).not.toContain('model_reasoning_effort')
		expect(launch.omitted).toEqual(['the max effort'])
	})

	it('runs an npm shim through Command Prompt on Windows', () => {
		const launch = buildEngineLaunch({ engine: 'codex-cli', permissionMode: 'plan' }, windows, {
			name: 'api',
		})
		expect(launch.command).toBe('cmd.exe')
		expect(launch.args.slice(0, 4)).toEqual([
			'/d',
			'/c',
			'call',
			'C:\\Users\\A\\AppData\\Roaming\\npm\\codex.cmd',
		])
	})

	it('says so when the program is missing', () => {
		expect(() =>
			buildEngineLaunch(
				{ engine: 'codex-cli', permissionMode: 'plan' },
				{ ...linux, resolve: () => undefined },
				{
					name: 'p',
				},
			),
		).toThrow(/Codex CLI is not installed/)
	})
})

describe('the composer message', () => {
	it('starts an installed engine on the message, after a separator', () => {
		for (const [engine, name] of [
			['codex-cli', 'codex'],
			['claude-code', 'claude'],
		] as const) {
			const launch = buildEngineLaunch(
				{ engine, permissionMode: 'plan', prompt: '--rm -rf: fix the build' },
				linux,
				{ name: 'api' },
			)
			expect(launch.command).toBe(`/usr/bin/${name}`)
			expect(launch.args.slice(-2)).toEqual(['--', '--rm -rf: fix the build'])
			expect(launch.omitted).toEqual([])
		}
	})

	it('never puts the message of the Namzu engine on the command line', () => {
		const launch = buildEngineLaunch(
			{ engine: 'namzu', permissionMode: 'plan', prompt: 'hello' },
			linux,
			{ name: 'api' },
		)
		expect(launch.args).not.toContain('hello')
	})

	it('leaves the message in the composer when Command Prompt would read it as syntax', () => {
		const launch = buildEngineLaunch(
			{ engine: 'codex-cli', permissionMode: 'plan', prompt: 'a && b' },
			windows,
			{ name: 'api' },
		)
		expect(launch.omitted).toEqual([PROMPT_NOT_PASSED])
		expect(launch.args).not.toContain('a && b')
		// A native program takes the same message as an argument.
		const native = buildEngineLaunch(
			{ engine: 'claude-code', permissionMode: 'plan', prompt: 'a && b' },
			windows,
			{ name: 'api' },
		)
		expect(native.omitted).toEqual([])
		expect(native.args.slice(-2)).toEqual(['--', 'a && b'])
	})

	it('ignores a blank message', () => {
		const launch = buildEngineLaunch(
			{ engine: 'codex-cli', permissionMode: 'plan', prompt: '  \n' },
			linux,
			{ name: 'api' },
		)
		expect(launch.args).not.toContain('--')
	})
})

describe('Claude Code engine launch', () => {
	it.each([
		['prompt', 'default'],
		['accept-edits', 'acceptEdits'],
		['auto', 'bypassPermissions'],
		['plan', 'plan'],
		['strict', 'dontAsk'],
	] as const)('maps %s to %s', (mode, argument) => {
		expect(secondEnginePermissionArgument(mode)).toBe(argument)
	})

	it('passes model, effort and permission mode', () => {
		const launch = buildEngineLaunch(
			{ engine: 'claude-code', model: 'opus', effort: 'max', permissionMode: 'plan' },
			linux,
			{ name: 'api' },
		)
		expect(launch).toMatchObject({
			command: '/usr/bin/claude',
			args: ['--model', 'opus', '--effort', 'max', '--permission-mode', 'plan'],
			title: 'Claude Code · api',
		})
	})

	it('starts a native Windows program directly', () => {
		const launch = buildEngineLaunch({ engine: 'claude-code', permissionMode: 'prompt' }, windows, {
			name: 'api',
		})
		expect(launch.command).toBe('C:\\Users\\A\\.local\\bin\\claude.exe')
		expect(launch.args).toEqual(['--permission-mode', 'default'])
	})

	it('omits an effort Claude Code does not offer', () => {
		const launch = buildEngineLaunch(
			{ engine: 'claude-code', effort: 'minimal', permissionMode: 'plan' },
			linux,
			{ name: 'api' },
		)
		expect(launch.args).toEqual(['--permission-mode', 'plan'])
		expect(launch.omitted).toEqual(['the minimal effort'])
	})
})

describe('findWindowsProgram', () => {
	const files = new Set([
		'C:\\Users\\A\\AppData\\Roaming\\npm\\codex.cmd',
		'D:\\tools\\claude.exe',
		'C:\\old\\claude.cmd',
	])
	const input = {
		path: 'C:\\Windows;D:\\tools\\;C:\\old',
		extensions: ['.exe', '.cmd'],
		extraDirectories: ['C:\\Users\\A\\AppData\\Roaming\\npm'],
		exists: (path: string) => files.has(path),
	}
	it('prefers a native program over a shim and flags a shim', () => {
		expect(findWindowsProgram('claude', input)).toEqual({
			path: 'D:\\tools\\claude.exe',
			shim: false,
		})
		expect(findWindowsProgram('codex', input)).toEqual({
			path: 'C:\\Users\\A\\AppData\\Roaming\\npm\\codex.cmd',
			shim: true,
		})
		expect(findWindowsProgram('missing', input)).toBeUndefined()
	})
})
