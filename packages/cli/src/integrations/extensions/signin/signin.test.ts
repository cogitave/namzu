import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { FakeRegistrar } from './fake.js'
import {
	type EngineLocation,
	START_CMD,
	START_SH,
	START_VBS,
	engineCmd,
	engineSh,
	writeLauncher,
} from './launcher.js'
import { LinuxRegistrar, autostartDir, desktopEntry, desktopQuote } from './linux.js'
import { MacRegistrar, bootoutArgs, bootstrapArgs, launchAgentPlist } from './macos.js'
import { createRegistrar, readRunnerState, reconcileSignin } from './reconcile.js'
import { LAUNCH_LABEL, RUN_KEY, RUN_VALUE, TASK_NAME } from './registrar.js'
import {
	WindowsRegistrar,
	addRunArgs,
	approvedDisabled,
	createTaskArgs,
	taskXml,
	utf16Bom,
} from './windows.js'

let home: string
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'ext-signin-'))
})
afterEach(() => removeTempDir(home))

const engine = (over: Partial<EngineLocation> = {}): EngineLocation => ({
	exe: process.execPath,
	args: ['/opt/namzu/bin.js'],
	env: {},
	...over,
})

describe('the launcher: the entry never names the engine itself', () => {
	it('writes engine.json, a derived file and the launcher, and only when something differs', () => {
		const root = join(home, 'extensions')
		const a = writeLauncher(root, engine(), 'linux')
		expect(a.changed).toBe(true)
		expect(JSON.parse(readFileSync(a.engineJson, 'utf8')).args).toEqual(['/opt/namzu/bin.js'])
		expect(readFileSync(a.launcher, 'utf8')).toBe(START_SH)
		expect(statSync(a.launcher).mode & 0o777).toBe(0o700)
		expect(writeLauncher(root, engine(), 'linux').changed).toBe(false)
		expect(writeLauncher(root, engine({ args: ['/opt/new/bin.js'] }), 'linux').changed).toBe(true)
	})
	it('quotes what a path may hold on POSIX and on Windows', () => {
		expect(engineSh(engine({ exe: "/o'dd path/node", args: ['/a b/c.js'] }))).toContain(
			`NAMZU_ENGINE_EXE='/o'\\''dd path/node'`,
		)
		expect(
			engineCmd(engine({ exe: 'C:\\Program Files\\n%x%', args: ['C:\\a b\\c.js'] })),
		).toContain('set "NAMZU_ENGINE_EXE=C:\\Program Files\\n%%x%%"')
		expect(() => engineCmd(engine({ exe: 'C:\\a"b' }))).toThrow()
		expect(START_CMD).toContain('extension daemon run')
	})
	it('running the launcher starts the engine where engine.json says now, so an update that moves it needs no new entry', () => {
		const root = join(home, 'extensions')
		const out = join(home, 'argv.txt')
		const make = (name: string) => {
			const f = join(home, `${name}.cjs`)
			writeFileSync(
				f,
				`require('node:fs').appendFileSync(${JSON.stringify(out)}, ${JSON.stringify(`${name} `)} + process.argv.slice(2).join(' ') + '\\n')`,
			)
			return f
		}
		const first = writeLauncher(root, engine({ args: [make('v1')] }), 'linux')
		execFileSync('/bin/sh', [first.launcher])
		// The engine moves (a kernel update): the same launcher, rewritten once, now reaches the new place.
		const second = writeLauncher(root, engine({ args: [make('v2')] }), 'linux')
		expect(second.launcher).toBe(first.launcher)
		execFileSync('/bin/sh', [second.launcher])
		expect(readFileSync(out, 'utf8').trim().split('\n')).toEqual([
			'v1 extension daemon start --signin',
			'v2 extension daemon start --signin',
		])
	})
	it('a launcher with no engine file does nothing and exits 0', () => {
		const root = join(home, 'extensions')
		const l = writeLauncher(root, engine(), 'linux')
		writeFileSync(join(root, '_runner', 'engine.sh'), '')
		// An empty derived file leaves no engine to start; remove it entirely for the missing case.
		execFileSync('/bin/sh', [
			'-c',
			`rm "${join(root, '_runner', 'engine.sh')}" && sh "${l.launcher}"`,
		])
	})
})

describe('Linux: an XDG autostart file, written under the temp home', () => {
	it('registers, reads back, and removes by deleting the file', async () => {
		const dir = autostartDir({ XDG_CONFIG_HOME: join(home, 'xdg'), HOME: home })
		expect(dir).toBe(join(home, 'xdg', 'autostart'))
		const reg = new LinuxRegistrar(dir)
		expect(await reg.status()).toEqual({ registered: false })
		const r = await reg.register({ launcher: '/h/extensions/_runner/start.sh' })
		expect(r).toEqual({ ok: true, kind: 'xdg' })
		const text = readFileSync(join(dir, 'namzu-extension-runner.desktop'), 'utf8')
		expect(text).toBe(desktopEntry({ launcher: '/h/extensions/_runner/start.sh' }))
		expect(text).toContain('Exec="/h/extensions/_runner/start.sh"')
		expect(text).toContain('Terminal=false')
		expect(await reg.status()).toEqual({ registered: true, kind: 'xdg' })
		await reg.unregister()
		expect(existsSync(join(dir, 'namzu-extension-runner.desktop'))).toBe(false)
	})
	it('respects an entry the person switched off', async () => {
		const dir = join(home, 'autostart')
		const reg = new LinuxRegistrar(dir)
		await reg.register({ launcher: '/x/start.sh' })
		const f = join(dir, 'namzu-extension-runner.desktop')
		writeFileSync(
			f,
			readFileSync(f, 'utf8').replace('Autostart-enabled=true', 'Autostart-enabled=false'),
		)
		expect(await reg.status()).toMatchObject({ registered: true, disabledByOs: true })
		const before = readFileSync(f, 'utf8')
		await reg.register({ launcher: '/x/start.sh' })
		expect(readFileSync(f, 'utf8')).toBe(before)
	})
	it('quotes an Exec path the way the entry format wants', () => {
		expect(desktopQuote('/a b/$c/"d"/e\\f/100%')).toBe('"/a b/\\$c/\\"d\\"/e\\\\\\\\f/100%%"')
	})
})

describe('Windows: command lines, checked without running anything', () => {
	const calls: [string, string[]][] = []
	const mk = (codes: Record<string, number>, out: Record<string, string> = {}) =>
		new WindowsRegistrar(
			async (file, args) => {
				calls.push([file, [...args]])
				const k = `${file} ${args[0]}`
				return { code: codes[k] ?? 0, stdout: out[k] ?? '', stderr: '' }
			},
			join(home, 'task.xml'),
			'PC\\me',
		)
	beforeEach(() => {
		calls.length = 0
	})
	it('the task: a log-on trigger for the current user, least privilege, visible, no time limit, restart on failure', () => {
		const x = taskXml(
			{ launcher: 'C:\\Users\\me\\.namzu\\extensions\\_runner\\start.cmd' },
			'PC\\me',
		)
		expect(x).toContain('<LogonTrigger>')
		expect(x).toContain('<UserId>PC\\me</UserId>')
		expect(x).toContain('<LogonType>InteractiveToken</LogonType>')
		expect(x).toContain('<RunLevel>LeastPrivilege</RunLevel>')
		expect(x).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
		expect(x).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
		expect(x).toContain('<Hidden>false</Hidden>')
		expect(x).toContain('<Interval>PT1M</Interval>')
		expect(x).toContain('<Count>3</Count>')
		expect(x).toContain('<Command>C:\\Users\\me\\.namzu\\extensions\\_runner\\start.cmd</Command>')
		expect(x).not.toContain('Highest')
		expect(taskXml({ launcher: 'C:\\a&b<c>.cmd' }, 'x')).toContain('C:\\a&amp;b&lt;c&gt;.cmd')
	})
	it('the task and the Run key start the hidden launcher through the script host, never a console file', () => {
		const spec = {
			launcher: 'C:\\Users\\me\\.namzu\\extensions\\_runner\\start.cmd',
			hiddenLauncher: 'C:\\Users\\me\\.namzu\\extensions\\_runner\\start.vbs',
		}
		const x = taskXml(spec, 'PC\\me')
		expect(x).toContain('<Command>wscript.exe</Command>')
		expect(x).toContain(
			'<Arguments>//B //Nologo &quot;C:\\Users\\me\\.namzu\\extensions\\_runner\\start.vbs&quot;</Arguments>',
		)
		expect(x).not.toContain('start.cmd')
		expect(addRunArgs(spec.launcher, spec.hiddenLauncher).at(-2)).toBe(
			'wscript.exe //B //Nologo "C:\\Users\\me\\.namzu\\extensions\\_runner\\start.vbs"',
		)
	})
	it('the hidden launcher runs start.cmd with window style 0 and waits, so the task stays the runner parent', () => {
		expect(START_VBS).toContain('start.cmd')
		expect(START_VBS).toMatch(/, 0, True\)/)
		expect(START_VBS).toContain('WScript.Quit rc')
		expect(START_VBS).not.toContain('\n\n\r')
		expect(START_VBS.split('\r\n').every((l) => !l.includes('\n'))).toBe(true)
	})
	it('on Windows the launcher writes start.vbs beside start.cmd, and changing nothing writes nothing', () => {
		const root = join(home, 'extensions')
		const a = writeLauncher(root, engine(), 'win32')
		expect(a.hidden).toBe(join(root, '_runner', 'start.vbs'))
		expect(readFileSync(a.hidden as string, 'utf8')).toBe(START_VBS)
		expect(writeLauncher(root, engine(), 'win32').changed).toBe(false)
		expect(writeLauncher(root, engine(), 'linux').hidden).toBeUndefined()
	})
	it('the task file is UTF-16 with a byte-order mark', () => {
		const b = utf16Bom('ab')
		expect([...b]).toEqual([0xff, 0xfe, 0x61, 0, 0x62, 0])
	})
	it('the command lines: schtasks create, and the Run key fallback', () => {
		expect(createTaskArgs('C:\\t.xml')).toEqual([
			'/Create',
			'/TN',
			TASK_NAME,
			'/XML',
			'C:\\t.xml',
			'/F',
		])
		expect(TASK_NAME).toBe('\\Namzu\\Extension Runner')
		expect(addRunArgs('C:\\s\\start.cmd')).toEqual([
			'add',
			RUN_KEY,
			'/v',
			RUN_VALUE,
			'/t',
			'REG_SZ',
			'/d',
			'"C:\\s\\start.cmd"',
			'/f',
		])
		expect(RUN_KEY.startsWith('HKCU\\')).toBe(true)
	})
	it('a task that can be created is the answer, and the Run key of an earlier fallback is removed', async () => {
		const r = await mk({}).register({ launcher: 'C:\\s\\start.cmd' })
		expect(r).toEqual({ ok: true, kind: 'task' })
		expect(calls.map((c) => `${c[0]} ${c[1][0]}`)).toEqual(['schtasks /Create', 'reg delete'])
		expect(readFileSync(join(home, 'task.xml')).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]))
	})
	it('when a standard user cannot create the task, the Run key is used and recorded as the kind', async () => {
		const r = await mk({ 'schtasks /Create': 1 }).register({ launcher: 'C:\\s\\start.cmd' })
		expect(r).toEqual({ ok: true, kind: 'run' })
		expect(calls.map((c) => `${c[0]} ${c[1][0]}`)).toEqual(['schtasks /Create', 'reg add'])
	})
	it('when neither works, it says so and registers nothing', async () => {
		const r = await mk({ 'schtasks /Create': 1, 'reg add': 1 }).register({
			launcher: 'C:\\s\\start.cmd',
		})
		expect(r.ok).toBe(false)
	})
	it('removal deletes the task and the Run value, never anything under HKLM', async () => {
		await mk({}).unregister()
		const flat = JSON.stringify(calls)
		expect(flat).toContain('/Delete')
		expect(flat).toContain('"delete"')
		expect(flat).not.toContain('HKLM')
	})
	it('status reads which one exists and whether Windows switched the startup app off', async () => {
		expect(await mk({ 'schtasks /Query': 1, 'reg query': 1 }).status()).toEqual({
			registered: false,
		})
		expect(
			await mk({}, { 'schtasks /Query': '<Settings><Enabled>true</Enabled></Settings>' }).status(),
		).toEqual({
			registered: true,
			kind: 'task',
		})
		expect(
			await mk({}, { 'schtasks /Query': '<Settings><Enabled>false</Enabled></Settings>' }).status(),
		).toMatchObject({ kind: 'task', disabledByOs: true })
		const run = mk(
			{ 'schtasks /Query': 1 },
			{ 'reg query': `${RUN_VALUE}    REG_SZ    "x"\n    REG_BINARY    030000000000000000000000` },
		)
		expect(await run.status()).toMatchObject({ registered: true, kind: 'run', disabledByOs: true })
		expect(approvedDisabled('NamzuExtensionRunner    REG_BINARY    020000000000000000000000')).toBe(
			false,
		)
		expect(approvedDisabled('NamzuExtensionRunner    REG_BINARY    060000000000000000000000')).toBe(
			false,
		)
	})
})

describe('macOS: a LaunchAgent for this user only', () => {
	it('the plist and the commands', async () => {
		const p = launchAgentPlist({ launcher: '/Users/me/.namzu/extensions/_runner/start.sh' })
		expect(p).toContain(`<string>${LAUNCH_LABEL}</string>`)
		expect(p).toContain('<key>RunAtLoad</key>\n\t<true/>')
		expect(p).toContain('<string>Background</string>')
		expect(p).toContain('<string>Aqua</string>')
		expect(bootstrapArgs(501, '/p.plist')).toEqual(['bootstrap', 'gui/501', '/p.plist'])
		expect(bootoutArgs(501)).toEqual(['bootout', `gui/501/${LAUNCH_LABEL}`])
		const ran: string[][] = []
		const reg = new MacRegistrar(join(home, 'LaunchAgents'), 501, async (_f, a) => {
			ran.push([...a])
			return { code: 0, stdout: '', stderr: '' }
		})
		expect(await reg.register({ launcher: '/x/start.sh' })).toEqual({
			ok: true,
			kind: 'launchagent',
		})
		expect(existsSync(join(home, 'LaunchAgents', `${LAUNCH_LABEL}.plist`))).toBe(true)
		expect(ran.map((a) => a[0])).toEqual(['bootout', 'bootstrap'])
		await reg.unregister()
		expect(existsSync(join(home, 'LaunchAgents', `${LAUNCH_LABEL}.plist`))).toBe(false)
	})
})

describe('reconcile: the entry exists exactly while a background extension is enabled', () => {
	const root = () => join(home, 'extensions')
	const input = (reg: FakeRegistrar, wanted: boolean) => ({
		registrar: reg,
		extensionsRoot: root(),
		engine: engine(),
		platform: 'linux' as const,
		wanted,
	})
	beforeEach(() => mkdirSync(root(), { recursive: true }))

	it('creates it when wanted, names the launcher and not the engine, and is idempotent', async () => {
		const reg = new FakeRegistrar()
		const s = await reconcileSignin(input(reg, true))
		expect(s).toMatchObject({ registered: true, kind: 'xdg' })
		expect(reg.entry?.launcher).toBe(join(root(), '_runner', 'start.sh'))
		expect(reg.entry?.launcher).not.toContain('bin.js')
		await reconcileSignin(input(reg, true))
		expect(reg.calls.filter((c) => c === 'register')).toHaveLength(1)
		expect(readRunnerState(root())?.signin.registered).toBe(true)
	})
	it('turning background off removes the entry and the launcher, and never data', async () => {
		mkdirSync(join(root(), 'com.example.x', 'data'), { recursive: true })
		writeFileSync(join(root(), 'com.example.x', 'data', 'rows'), '1')
		const reg = new FakeRegistrar()
		await reconcileSignin(input(reg, true))
		await reconcileSignin(input(reg, false))
		expect(reg.entry).toBeUndefined()
		expect(existsSync(join(root(), '_runner', 'start.sh'))).toBe(false)
		expect(readFileSync(join(root(), 'com.example.x', 'data', 'rows'), 'utf8')).toBe('1')
		expect(readRunnerState(root())?.signin.registered).toBe(false)
	})
	it('a moved engine repairs the launcher and registers again', async () => {
		const reg = new FakeRegistrar()
		await reconcileSignin(input(reg, true))
		await reconcileSignin({ ...input(reg, true), engine: engine({ args: ['/elsewhere/bin.js'] }) })
		expect(reg.calls.filter((c) => c === 'register')).toHaveLength(2)
		expect(JSON.parse(readFileSync(join(root(), '_runner', 'engine.json'), 'utf8')).args).toEqual([
			'/elsewhere/bin.js',
		])
	})
	it('never re-enables an entry the person switched off in the operating system, and says so', async () => {
		const reg = new FakeRegistrar()
		await reconcileSignin(input(reg, true))
		reg.disabledByOs = true
		const s = await reconcileSignin({
			...input(reg, true),
			engine: engine({ args: ['/moved.js'] }),
		})
		expect(s).toMatchObject({ registered: true, disabledByOs: true })
		expect(reg.calls.filter((c) => c === 'register')).toHaveLength(1)
		expect(readRunnerState(root())?.signin.disabledByOs).toBe(true)
	})
	it('says why when the entry cannot be made, and when there is no mechanism on the system', async () => {
		const reg = new FakeRegistrar()
		reg.failRegister = 'access denied'
		expect(await reconcileSignin(input(reg, true))).toMatchObject({
			registered: false,
			reason: 'access denied',
		})
		expect(await reconcileSignin({ ...input(reg, true), registrar: undefined })).toMatchObject({
			registered: false,
			reason: 'no sign-in mechanism on this system',
		})
	})
	it('on Linux the real registrar writes only under the temp XDG folder', async () => {
		const reg = createRegistrar({
			platform: 'linux',
			extensionsRoot: root(),
			env: { XDG_CONFIG_HOME: join(home, 'xdg'), HOME: home },
		})
		const s = await reconcileSignin({ ...input(new FakeRegistrar(), true), registrar: reg })
		expect(s).toMatchObject({ registered: true, kind: 'xdg' })
		expect(existsSync(join(home, 'xdg', 'autostart', 'namzu-extension-runner.desktop'))).toBe(true)
		await reconcileSignin({ ...input(new FakeRegistrar(), false), registrar: reg })
		expect(existsSync(join(home, 'xdg', 'autostart', 'namzu-extension-runner.desktop'))).toBe(false)
	})
	it('dry mode on Windows and macOS runs nothing and writes only under _signin-dry', async () => {
		const win = createRegistrar({
			platform: 'win32',
			extensionsRoot: root(),
			env: { NAMZU_EXT_SIGNIN_DRY: '1', USERNAME: 'me', USERDOMAIN: 'PC' },
		})
		const s = await reconcileSignin({
			...input(new FakeRegistrar(), true),
			platform: 'win32',
			registrar: win,
		})
		expect(s.registered).toBe(true)
		const log = readFileSync(join(root(), '_signin-dry', 'commands.log'), 'utf8')
		expect(log).toContain('schtasks')
		expect(existsSync(join(root(), '_signin-dry', 'signin-task.xml'))).toBe(true)
		const mac = createRegistrar({
			platform: 'darwin',
			extensionsRoot: root(),
			env: { NAMZU_EXT_SIGNIN_DRY: '1', HOME: home },
		})
		await reconcileSignin({
			...input(new FakeRegistrar(), true),
			platform: 'darwin',
			registrar: mac,
		})
		expect(existsSync(join(root(), '_signin-dry', 'LaunchAgents', `${LAUNCH_LABEL}.plist`))).toBe(
			true,
		)
		expect(existsSync(join(home, 'Library'))).toBe(false)
	})
})
