import { describe, expect, it } from 'vitest'
import type {
	EngineUpdateId,
	EngineUpdateNotice,
	EngineUpdatesState,
} from '../shared/engine-update-protocol.js'
import {
	type EngineLaunchSpec,
	type EngineUpdateCache,
	EngineUpdates,
	type EngineUpdatesDeps,
	classifyInstall,
	emptyCache,
	failureText,
	updateCommandText,
	updateLaunch,
} from './engine-updates.js'
import { checkIntervalMs } from './updater.js'

const WINDOWS = {
	platform: 'win32' as const,
	home: 'C:\\Users\\Arda',
	appData: 'C:\\Users\\Arda\\AppData\\Roaming',
}
const LINUX = {
	platform: 'linux' as const,
	home: '/home/arda',
	npmPrefix: '/home/arda/.npm-global',
}

describe('where a program was installed', () => {
	it.each([
		[
			'codex-cli',
			'C:\\Users\\Arda\\AppData\\Roaming\\npm\\codex.cmd',
			undefined,
			WINDOWS,
			'npm-global',
		],
		['claude-code', 'C:\\Users\\Arda\\.local\\bin\\claude.exe', undefined, WINDOWS, 'native'],
		[
			'namzu-cli',
			'C:\\Users\\Arda\\AppData\\Roaming\\npm\\namzu.cmd',
			undefined,
			WINDOWS,
			'npm-global',
		],
		['codex-cli', 'C:\\Tools\\codex.exe', undefined, WINDOWS, 'unknown'],
		['codex-cli', '/home/arda/.npm-global/bin/codex', undefined, LINUX, 'npm-global'],
		[
			'codex-cli',
			'/usr/local/bin/codex',
			'/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
			LINUX,
			'npm-global',
		],
		[
			'claude-code',
			'/home/arda/.local/bin/claude',
			'/home/arda/.local/share/claude/versions/2.1.290',
			LINUX,
			'native',
		],
		[
			'codex-cli',
			'/home/arda/.codex/packages/standalone/current/codex',
			undefined,
			LINUX,
			'standalone',
		],
		[
			'codex-cli',
			'/opt/homebrew/bin/codex',
			'/opt/homebrew/Cellar/codex/1.0/bin/codex',
			LINUX,
			'unknown',
		],
		[
			'claude-code',
			'/home/arda/.local/bin/claude',
			'/home/arda/lib/node_modules/@anthropic-ai/claude-code/cli.js',
			LINUX,
			'npm-global',
		],
	] as const)('%s at %s is %s', (id, path, realPath, context, method) => {
		expect(classifyInstall(id, { path, ...(realPath ? { realPath } : {}) }, context)).toBe(method)
	})

	it('reads an npm shim on Windows for the package it starts, wherever the prefix is', () => {
		const shim = '@ECHO off\r\n"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
		expect(
			classifyInstall('codex-cli', { path: 'D:\\tools\\npm\\codex.cmd', shimText: shim }, WINDOWS),
		).toBe('npm-global')
		expect(
			classifyInstall(
				'codex-cli',
				{ path: 'D:\\tools\\codex.cmd', shimText: '@echo off\r\nexit 1' },
				WINDOWS,
			),
		).toBe('unknown')
		// Another package's shim is not this one's.
		expect(
			classifyInstall('claude-code', { path: 'D:\\tools\\claude.cmd', shimText: shim }, WINDOWS),
		).toBe('unknown')
	})

	it('never reads a Codex program in ~/.local/bin as the native Claude install', () => {
		expect(classifyInstall('codex-cli', { path: '/home/arda/.local/bin/codex' }, LINUX)).toBe(
			'unknown',
		)
	})
})

describe('the command an update runs', () => {
	const npm = { path: 'C:\\Program Files\\nodejs\\npm.cmd', shim: true }
	it('goes through Command Prompt for an npm shim on Windows, never PowerShell', () => {
		expect(
			updateLaunch({
				id: 'codex-cli',
				method: 'npm-global',
				npm,
				platform: 'win32',
				commandPrompt: 'C:\\Windows\\System32\\cmd.exe',
			}),
		).toEqual({
			command: 'C:\\Windows\\System32\\cmd.exe',
			args: ['/d', '/c', 'call', npm.path, 'install', '-g', '@openai/codex@latest'],
			title: 'Updating Codex CLI',
		})
	})
	it('pins npm to the registry the check used', () => {
		expect(
			updateLaunch({
				id: 'codex-cli',
				method: 'npm-global',
				npm: { path: '/usr/bin/npm', shim: false },
				platform: 'linux',
				registry: 'https://registry.npmjs.org',
			})?.args,
		).toEqual(['install', '-g', '--registry=https://registry.npmjs.org', '@openai/codex@latest'])
	})
	it('runs the native and standalone updaters by their own name', () => {
		const program = { path: '/home/arda/.local/bin/claude', shim: false }
		expect(
			updateLaunch({ id: 'claude-code', method: 'native', program, platform: 'linux' }),
		).toEqual({ command: program.path, args: ['update'], title: 'Updating Claude Code' })
		expect(
			updateLaunch({
				id: 'codex-cli',
				method: 'standalone',
				program: { path: '/h/.codex/packages/codex', shim: false },
				platform: 'linux',
			})?.args,
		).toEqual(['update'])
	})
	it('refuses an install it does not know and a path Command Prompt would read as syntax', () => {
		expect(updateLaunch({ id: 'codex-cli', method: 'unknown', platform: 'linux' })).toBeUndefined()
		expect(
			updateLaunch({ id: 'codex-cli', method: 'npm-global', platform: 'linux' }),
		).toBeUndefined()
		expect(
			updateLaunch({
				id: 'codex-cli',
				method: 'npm-global',
				npm: { path: 'C:\\a&b\\npm.cmd', shim: true },
				platform: 'win32',
			}),
		).toBeUndefined()
	})
	it('names the command for a person without any path', () => {
		expect(updateCommandText('codex-cli', 'npm-global')).toBe('npm install -g @openai/codex@latest')
		expect(updateCommandText('claude-code', 'native')).toBe('claude update')
		expect(updateCommandText('codex-cli', 'unknown')).toBe('codex update')
		expect(updateCommandText('namzu-cli', 'unknown')).toBe('npm install -g @namzu/cli@latest')
	})
})

describe('why an update stopped', () => {
	it('tells a person to close other windows when Windows keeps the program open', () => {
		expect(
			failureText('codex-cli', 'win32', 'npm error code EBUSY\r\nresource busy or locked'),
		).toMatch(
			/Close other Codex CLI windows, and any Codex CLI conversation or terminal tab in Namzu, then try again/,
		)
		expect(
			failureText('codex-cli', 'win32', '\u001b[31mEPERM: operation not permitted\u001b[0m'),
		).toMatch(/Close other Codex CLI windows/)
	})
	it('names missing rights and otherwise points at the terminal', () => {
		expect(failureText('codex-cli', 'linux', 'EACCES: permission denied')).toMatch(
			/opened as administrator/,
		)
		expect(failureText('codex-cli', 'linux', 'EPERM')).toBe(
			'Codex CLI update failed. The terminal tab shows why.',
		)
		expect(failureText('claude-code', 'linux', undefined)).toBe(
			'Claude Code update failed. The terminal tab shows why.',
		)
	})
})

/* ----------------------------------------------------------------- the controller */

const HOUR = 60 * 60 * 1000

interface Fake {
	updates: EngineUpdates
	states: EngineUpdatesState[]
	notices: { windowId?: string; notice: EngineUpdateNotice }[]
	opened: { launch: EngineLaunchSpec; groupId: string }[]
	stopped: EngineUpdateId[]
	changed: EngineUpdateId[]
	closed: string[]
	registry: Map<string, string | undefined>
	versions: Map<string, string | undefined>
	fetches: string[]
	cache: { value: EngineUpdateCache; writes: number }
	clock: { now: number; first?: () => void; every?: () => void; delay?: number }
	blockers: Map<EngineUpdateId, string>
	failOpen?: string
}

const CODEX = { path: '/h/.npm-global/bin/codex', shim: false }
const SECOND = { path: '/home/arda/.local/bin/claude', shim: false }
const NPM = { path: '/usr/bin/npm', shim: false }

function setup(
	over: Partial<EngineUpdatesDeps> = {},
	cache: EngineUpdateCache = emptyCache(),
): Fake {
	const fake: Fake = {
		updates: undefined as never,
		states: [],
		notices: [],
		opened: [],
		stopped: [],
		changed: [],
		closed: [],
		registry: new Map([
			['@openai/codex', '0.162.0'],
			['@anthropic-ai/claude-code', '2.1.295'],
			['@namzu/cli', '36.0.0'],
		]),
		versions: new Map([
			[CODEX.path, '0.154.0'],
			[SECOND.path, '2.1.290'],
		]),
		fetches: [],
		cache: { value: cache, writes: 0 },
		clock: { now: 1_000_000_000 },
		blockers: new Map(),
	}
	const programs = (name: string): { path: string; shim: boolean } | undefined =>
		name === 'codex' ? CODEX : name === 'claude' ? SECOND : name === 'npm' ? NPM : undefined
	fake.updates = new EngineUpdates({
		platform: 'linux',
		install: { platform: 'linux', home: '/home/arda', npmPrefix: '/h/.npm-global' },
		find: programs,
		realPath: () => undefined,
		version: async (program) => fake.versions.get(program.path),
		latest: async (pkg) => {
			fake.fetches.push(pkg)
			return fake.registry.get(pkg)
		},
		bundledVersion: () => '35.0.0',
		cache: {
			read: () => structuredClone(fake.cache.value),
			write: (value) => {
				fake.cache.value = structuredClone(value)
				fake.cache.writes++
			},
		},
		clock: {
			now: () => fake.clock.now,
			after: (ms, run) => {
				fake.clock.delay = ms
				fake.clock.first = run
				return () => {
					fake.clock.first = undefined
				}
			},
			every: (_ms, run) => {
				fake.clock.every = run
				return () => {
					fake.clock.every = undefined
				}
			},
		},
		blocker: (id) => fake.blockers.get(id),
		stopServers: async (id) => {
			fake.stopped.push(id)
		},
		open: async (context, launch) => {
			if (fake.failOpen) throw new Error(fake.failOpen)
			fake.opened.push({ launch, groupId: context.groupId })
			return { tabId: 'terminal-1' }
		},
		updated: (id) => fake.changed.push(id),
		finished: (tabId) => fake.closed.push(tabId),
		broadcast: (state) => fake.states.push(state),
		notice: (windowId, notice) => fake.notices.push({ windowId, notice }),
		record: () => undefined,
		...over,
	})
	return fake
}

const settle = async () => {
	for (let turn = 0; turn < 30; turn++) await Promise.resolve()
}

const item = (fake: Fake, id: EngineUpdateId) => {
	const found = fake.updates.state().items.find((row) => row.id === id)
	if (!found) throw new Error(`no ${id}`)
	return found
}

describe('checking for newer versions', () => {
	it('reads what is installed at launch and asks the registry only after the first delay', async () => {
		const fake = setup()
		fake.updates.start()
		await settle()
		expect(fake.fetches).toEqual([])
		expect(item(fake, 'codex-cli')).toMatchObject({
			installed: '0.154.0',
			status: 'unknown',
			method: 'npm-global',
		})
		expect(fake.clock.delay).toBe(30_000)
		fake.clock.first?.()
		await settle()
		expect(item(fake, 'codex-cli')).toMatchObject({
			installed: '0.154.0',
			latest: '0.162.0',
			status: 'available',
		})
		expect(item(fake, 'claude-code')).toMatchObject({ status: 'available', method: 'native' })
	})

	it('classifies an npm shim by the package it starts, through the controller', async () => {
		const shim = { path: 'D:\\tools\\npm\\codex.cmd', shim: true }
		const fake = setup({
			platform: 'win32',
			install: {
				platform: 'win32',
				home: 'C:\\Users\\Arda',
				appData: 'C:\\Users\\Arda\\AppData\\Roaming',
			},
			find: (name) =>
				name === 'codex'
					? shim
					: name === 'npm'
						? { path: 'D:\\nodejs\\npm.cmd', shim: true }
						: undefined,
			shimText: () => '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
			version: async () => '0.154.0',
		})
		await fake.updates.check()
		expect(item(fake, 'codex-cli')).toMatchObject({ method: 'npm-global', runnable: true })
	})

	it('treats a bundled Namzu command line as current and says it updates with the app', async () => {
		const fake = setup()
		await fake.updates.check()
		expect(item(fake, 'namzu-cli')).toMatchObject({
			bundled: true,
			method: 'bundled',
			status: 'current',
			installed: '35.0.0',
			runnable: false,
		})
		expect(item(fake, 'namzu-cli').note).toMatch(/updates with the app/)
	})

	it('reads a standalone Namzu command line against the registry', async () => {
		const fake = setup({
			find: (name) =>
				name === 'namzu'
					? { path: '/h/.npm-global/bin/namzu', shim: false }
					: name === 'npm'
						? NPM
						: name === 'codex'
							? CODEX
							: SECOND,
			version: async (program) =>
				program.path.endsWith('namzu') ? '35.0.0' : fake.versions.get(program.path),
		})
		await fake.updates.check()
		expect(item(fake, 'namzu-cli')).toMatchObject({
			status: 'available',
			latest: '36.0.0',
			method: 'npm-global',
			runnable: true,
		})
	})

	it('shows a program that is not installed as such and offers nothing', async () => {
		const fake = setup({
			find: (name) => (name === 'claude' ? undefined : name === 'codex' ? CODEX : NPM),
		})
		await fake.updates.check()
		expect(item(fake, 'claude-code')).toMatchObject({
			missing: true,
			status: 'unknown',
			runnable: false,
		})
	})

	it('is quiet offline: the last answer stays and nothing new is shown', async () => {
		const fake = setup()
		await fake.updates.check()
		const checkedAt = fake.updates.state().checkedAt
		fake.registry.clear()
		fake.clock.now += HOUR
		await fake.updates.check()
		expect(item(fake, 'codex-cli')).toMatchObject({ latest: '0.162.0', status: 'available' })
		expect(fake.updates.state().checkedAt).toBe(checkedAt)
	})

	it('does not show an answer older than a week as news', async () => {
		const fake = setup()
		await fake.updates.check()
		fake.registry.clear()
		fake.clock.now += 8 * 24 * HOUR
		await fake.updates.check()
		expect(item(fake, 'codex-cli')).toMatchObject({ status: 'unknown' })
		expect(item(fake, 'codex-cli').latest).toBeUndefined()
	})

	it('shows a program that is current as up to date', async () => {
		const fake = setup()
		fake.versions.set(CODEX.path, '0.162.0')
		await fake.updates.check()
		expect(item(fake, 'codex-cli').status).toBe('current')
	})

	it('skips the registry at launch when the cache is newer than a check interval', async () => {
		const now = 1_000_000_000
		const cache: EngineUpdateCache = {
			latest: {
				'codex-cli': { version: '0.162.0', checkedAt: now - HOUR },
				'claude-code': { version: '2.1.295', checkedAt: now - HOUR },
				'namzu-cli': { version: '36.0.0', checkedAt: now - HOUR },
			},
			announced: {},
		}
		const fake = setup({}, cache)
		expect(item(fake, 'codex-cli').latest).toBe('0.162.0')
		fake.updates.start()
		fake.clock.first?.()
		await settle()
		expect(fake.fetches).toEqual([])
		expect(item(fake, 'codex-cli').status).toBe('available')
		// The interval always asks.
		fake.clock.every?.()
		await settle()
		expect(fake.fetches).toHaveLength(3)
		expect(checkIntervalMs).toBe(4 * HOUR)
	})

	it('asks the registry at launch when the cache is older than a check interval', async () => {
		const now = 1_000_000_000
		const cache: EngineUpdateCache = {
			latest: {
				'codex-cli': { version: '0.160.0', checkedAt: now - 5 * HOUR },
				'claude-code': { version: '2.1.295', checkedAt: now - HOUR },
				'namzu-cli': { version: '36.0.0', checkedAt: now - HOUR },
			},
			announced: {},
		}
		const fake = setup({}, cache)
		fake.updates.start()
		fake.clock.first?.()
		await settle()
		expect(fake.fetches).toHaveLength(3)
		expect(item(fake, 'codex-cli').latest).toBe('0.162.0')
	})

	it('persists the answers it got', async () => {
		const fake = setup()
		await fake.updates.check()
		expect(fake.cache.value.latest['codex-cli']).toEqual({
			version: '0.162.0',
			checkedAt: 1_000_000_000,
		})
	})

	it('runs one check at a time and reports it while it runs', async () => {
		const fake = setup()
		const first = fake.updates.check()
		const second = fake.updates.check()
		expect(second).toBe(first)
		expect(fake.states[0]?.checking).toBe(true)
		await first
		expect(fake.states.at(-1)?.checking).toBe(false)
		expect(fake.fetches).toHaveLength(3)
	})
})

describe('telling the person once', () => {
	it('announces each new version once, whichever window asks first', async () => {
		const fake = setup()
		await fake.updates.check()
		expect(fake.updates.claimAnnouncements()).toEqual([
			{ id: 'codex-cli', name: 'Codex CLI', version: '0.162.0' },
			{ id: 'claude-code', name: 'Claude Code', version: '2.1.295' },
		])
		expect(fake.updates.claimAnnouncements()).toEqual([])
		fake.registry.set('@openai/codex', '0.163.0')
		await fake.updates.check()
		expect(fake.updates.claimAnnouncements()).toEqual([
			{ id: 'codex-cli', name: 'Codex CLI', version: '0.163.0' },
		])
		expect(fake.cache.value.announced['codex-cli']).toBe('0.163.0')
	})

	it('keeps the announcement across a restart', async () => {
		const first = setup()
		await first.updates.check()
		first.updates.claimAnnouncements()
		const second = setup({}, first.cache.value)
		await second.updates.check()
		expect(second.updates.claimAnnouncements()).toEqual([])
	})
})

describe('running an update', () => {
	const context = { windowId: 'w1', groupId: 'g1', projectId: 'p1' }

	it('stops Namzu’s own idle servers, then runs the npm command in a visible tab', async () => {
		const fake = setup()
		await fake.updates.check()
		const result = await fake.updates.update('codex-cli', context)
		expect(result).toEqual({ ok: true, tabId: 'terminal-1' })
		expect(fake.stopped).toEqual(['codex-cli'])
		expect(fake.opened[0]).toEqual({
			groupId: 'g1',
			launch: {
				command: NPM.path,
				args: ['install', '-g', '@openai/codex@latest'],
				title: 'Updating Codex CLI',
			},
		})
		expect(item(fake, 'codex-cli')).toMatchObject({ status: 'updating', tabId: 'terminal-1' })
		expect(await fake.updates.update('codex-cli', context)).toMatchObject({ ok: false })
	})

	it('runs the native updater for Claude Code', async () => {
		const fake = setup()
		await fake.updates.check()
		await fake.updates.update('claude-code', context)
		expect(fake.opened[0]?.launch).toEqual({
			command: SECOND.path,
			args: ['update'],
			title: 'Updating Claude Code',
		})
	})

	it('refuses while the engine is working and changes nothing', async () => {
		const fake = setup()
		await fake.updates.check()
		fake.blockers.set('codex-cli', 'Close the Codex CLI tab first.')
		expect(await fake.updates.update('codex-cli', context)).toEqual({
			ok: false,
			reason: 'Close the Codex CLI tab first.',
		})
		expect(fake.stopped).toEqual([])
		expect(fake.opened).toEqual([])
		expect(item(fake, 'codex-cli').status).toBe('available')
	})

	it('asks again after the servers stopped and refuses if a turn started meanwhile', async () => {
		const fake = setup({
			stopServers: async (id) => {
				fake.stopped.push(id)
				fake.blockers.set(
					id,
					'A Codex CLI reply is still running. Wait for it to finish, then update.',
				)
			},
		})
		await fake.updates.check()
		expect(await fake.updates.update('codex-cli', context)).toMatchObject({ ok: false })
		expect(fake.opened).toEqual([])
		expect(item(fake, 'codex-cli').status).toBe('available')
	})

	it('runs one update at a time', async () => {
		const fake = setup()
		await fake.updates.check()
		expect(await fake.updates.update('codex-cli', context)).toMatchObject({ ok: true })
		expect(await fake.updates.update('claude-code', context)).toEqual({
			ok: false,
			reason: 'Another program is being updated. Wait for it to finish.',
		})
	})

	it('runs nothing for an install it cannot name, and hands over the command to copy', async () => {
		const fake = setup({
			find: (name) =>
				name === 'codex'
					? { path: '/opt/homebrew/bin/codex', shim: false }
					: name === 'npm'
						? NPM
						: SECOND,
		})
		fake.versions.set('/opt/homebrew/bin/codex', '0.154.0')
		await fake.updates.check()
		expect(item(fake, 'codex-cli')).toMatchObject({
			method: 'unknown',
			runnable: false,
			command: 'codex update',
		})
		expect(await fake.updates.update('codex-cli', context)).toMatchObject({
			ok: false,
			command: 'codex update',
		})
		expect(fake.opened).toEqual([])
	})

	it('refuses a program that is already current', async () => {
		const fake = setup()
		fake.versions.set(CODEX.path, '0.162.0')
		await fake.updates.check()
		expect(await fake.updates.update('codex-cli', context)).toMatchObject({ ok: false })
		expect(fake.opened).toEqual([])
	})

	it('carries the command when the terminal could not open', async () => {
		const fake = setup()
		await fake.updates.check()
		fake.failOpen = 'Open a trusted folder in Namzu first, or run the command yourself.'
		expect(await fake.updates.update('codex-cli', context)).toEqual({
			ok: false,
			reason: 'Open a trusted folder in Namzu first, or run the command yourself.',
			command: 'npm install -g @openai/codex@latest',
		})
		expect(item(fake, 'codex-cli').status).toBe('available')
	})

	it('goes quiet about stopping a server that would not stop', async () => {
		const fake = setup({
			stopServers: async () => {
				throw new Error('EPERM')
			},
		})
		await fake.updates.check()
		expect(await fake.updates.update('codex-cli', context)).toMatchObject({ ok: true })
	})
})

describe('after the terminal ends', () => {
	const context = { windowId: 'w1', groupId: 'g1' }
	async function started() {
		const fake = setup()
		await fake.updates.check()
		await fake.updates.update('codex-cli', context)
		return fake
	}

	it('re-reads the version, drops the engine’s model lists and tells the window', async () => {
		const fake = await started()
		fake.versions.set(CODEX.path, '0.162.0')
		await fake.updates.terminalEnded({ tabId: 'terminal-1', exitCode: 0, tail: '' })
		expect(item(fake, 'codex-cli')).toMatchObject({
			installed: '0.162.0',
			status: 'current',
			updated: true,
		})
		expect(fake.changed).toEqual(['codex-cli'])
		expect(fake.notices).toEqual([
			{ windowId: 'w1', notice: { text: 'Codex CLI updated to 0.162.0', tone: 'success' } },
		])
		// A successful update has nothing left to read, so its tab closes by itself.
		expect(fake.closed).toEqual(['terminal-1'])
	})

	it('says so when the version did not move, with where the program is', async () => {
		const fake = await started()
		await fake.updates.terminalEnded({ tabId: 'terminal-1', exitCode: 0, tail: '' })
		expect(item(fake, 'codex-cli')).toMatchObject({ status: 'failed' })
		expect(item(fake, 'codex-cli').error).toBe(
			'Updated, but the installed version is still 0.154.0. Another copy may be earlier on PATH (/h/.npm-global/bin/codex).',
		)
		expect(fake.changed).toEqual([])
		expect(fake.notices[0]?.notice).toEqual({
			text: 'Codex CLI update failed. The terminal tab shows why.',
			tone: 'error',
		})
	})

	it('reports a failed command and offers to try again', async () => {
		const fake = await started()
		await fake.updates.terminalEnded({ tabId: 'terminal-1', exitCode: 1, tail: 'npm ERR! boom' })
		expect(item(fake, 'codex-cli')).toMatchObject({
			status: 'failed',
			error: 'Codex CLI update failed. The terminal tab shows why.',
		})
		expect(fake.changed).toEqual([])
		fake.versions.set(CODEX.path, '0.162.0')
		const again = await fake.updates.update('codex-cli', context)
		expect(again).toMatchObject({ ok: true })
		expect(item(fake, 'codex-cli').status).toBe('updating')
	})

	it('reads an EBUSY from the end of the output', async () => {
		const fake = setup({ platform: 'win32' })
		await fake.updates.check()
		// The fake is Linux-shaped, so the Windows wording is tested through failureText above; here the
		// controller must pass the platform and tail through.
		await fake.updates.update('codex-cli', context)
		await fake.updates.terminalEnded({
			tabId: 'terminal-1',
			exitCode: 1,
			tail: 'EBUSY: resource busy',
		})
		expect(item(fake, 'codex-cli').error).toMatch(/Close other Codex CLI windows/)
	})

	it('reports a tab closed before the update finished', async () => {
		const fake = await started()
		await fake.updates.terminalEnded({ tabId: 'terminal-1', closed: true, tail: '' })
		expect(item(fake, 'codex-cli').error).toBe(
			'The Codex CLI update was stopped before it finished.',
		)
	})

	it('ignores a terminal it did not start', async () => {
		const fake = await started()
		await fake.updates.terminalEnded({ tabId: 'terminal-9', exitCode: 0, tail: '' })
		expect(item(fake, 'codex-cli').status).toBe('updating')
	})

	it('clears an old failure when the next check finds the program current', async () => {
		const fake = await started()
		await fake.updates.terminalEnded({ tabId: 'terminal-1', exitCode: 1, tail: '' })
		expect(item(fake, 'codex-cli').status).toBe('failed')
		fake.versions.set(CODEX.path, '0.162.0')
		await fake.updates.check()
		expect(item(fake, 'codex-cli').status).toBe('current')
	})
})
