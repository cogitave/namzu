// Run the CLI engine of a packed installer tree with the packed Electron executable as Node, the way
// the Desktop starts it (ELECTRON_RUN_AS_NODE=1), and fail with a plain message when it does not work.
//
// The staging machine (Linux) checks the staged tree but cannot load the Windows bindings; the machine
// that builds the installer can, so installer-after-pack.cjs calls this. It only imports Node built-ins
// because the Windows job runs it from the staged copy, where nothing else of the repository exists.
//
// It never reaches the network, and every child it starts is bounded by a timeout and killed (by pid,
// with the process tree on Windows) if it outlives it. It never prints environment variables.
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_TIMEOUTS = {
	versionMs: 60_000,
	initializeMs: 60_000,
	exitMs: 15_000,
	probeMs: 60_000,
}

/** Can the program of a `target` installer run on this `host`? */
export const runsOn = (target, host) => host.platform === target.platform && host.arch === target.arch

/** Which of `files` are missing from `cliDir`. A name ending in `/` is a folder that must hold an entry. */
export function missingFiles(cliDir, files) {
	return files.filter((file) => {
		const path = join(cliDir, file)
		if (!existsSync(path)) return true
		return file.endsWith('/') && readdirSync(path).length === 0
	})
}

/**
 * What to do with each native package once it is imported: one real, cheap operation with no side
 * effect. A package that is not listed is only imported. `m` is the imported module namespace.
 */
export const NATIVE_OPERATIONS = {
	sharp: `const sharp = m.default ?? m
const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000000' } }).png().toBuffer()
const meta = await sharp(png).metadata()
if (meta.width !== 1 || meta.height !== 1) throw new Error('a 1x1 image read back as ' + meta.width + 'x' + meta.height)`,
	'oxc-parser': `const result = m.parseSync('probe.js', 'let a = 1')
if (!result || (result.errors && result.errors.length > 0)) throw new Error('parsing "let a = 1" reported errors')`,
	// Terminals: load the binding and read its type; a terminal is never spawned.
	'@lydell/node-pty': `const pty = m.default ?? m
if (typeof pty.spawn !== 'function') throw new Error('the binding exports no spawn function')`,
	'node-pty': `const pty = m.default ?? m
if (typeof pty.spawn !== 'function') throw new Error('the binding exports no spawn function')`,
}

const MARK = 'NAMZU_SMOKE '

/** The script run from the packed CLI folder: imports each package, runs its operation, reports. */
export function probeScript(names) {
	const steps = names
		.map(
			(name) =>
				`await step(${JSON.stringify(name)}, async () => {\n const m = await import(${JSON.stringify(name)})\n${NATIVE_OPERATIONS[name] ?? ''}\n})`,
		)
		.join('\n')
	return `const failures = []
const step = async (name, run) => {
	try { await run() } catch (error) { failures.push({ name, message: String((error && error.message) || error).split('\\n')[0] }) }
}
${steps}
console.log(${JSON.stringify(MARK)} + JSON.stringify(failures))
`
}

/** The environment of every child: the build's own, minus what could point at other code, with scratch homes. */
export function smokeEnv(home, base = process.env) {
	const env = { ...base }
	for (const key of Object.keys(env))
		if (key === 'NODE_PATH' || key === 'NODE_OPTIONS' || key.startsWith('WSL')) delete env[key]
	return {
		...env,
		ELECTRON_RUN_AS_NODE: '1',
		HOME: home,
		USERPROFILE: home,
		APPDATA: join(home, 'AppData', 'Roaming'),
		LOCALAPPDATA: join(home, 'AppData', 'Local'),
		NAMZU_HOME: join(home, 'namzu'),
		CI: 'true',
	}
}

/** Stop a child for good: by its own handle, and on Windows its whole tree by pid. */
function killChild(spawn, child, platform) {
	try {
		child.kill()
	} catch {}
	if (platform === 'win32' && child.pid) {
		try {
			const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
				stdio: 'ignore',
				windowsHide: true,
			})
			killer.on?.('error', () => {})
		} catch {}
	}
}

const tail = (text, n = 400) => String(text).trim().slice(-n)

function runToEnd(ctx, args, timeoutMs) {
	const { spawn, exe, env, cwd, platform } = ctx
	return new Promise((resolve) => {
		let stdout = ''
		let stderr = ''
		let done = false
		let timer
		let child
		const finish = (result) => {
			if (done) return
			done = true
			clearTimeout(timer)
			resolve({ stdout, stderr, ...result })
		}
		try {
			child = spawn(exe, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
		} catch (error) {
			return finish({ code: null, error: error.message })
		}
		child.stdout?.on('data', (chunk) => {
			stdout += String(chunk)
		})
		child.stderr?.on('data', (chunk) => {
			stderr += String(chunk)
		})
		child.on('error', (error) => {
			killChild(spawn, child, platform)
			finish({ code: null, error: error.message })
		})
		child.on('close', (code) => finish({ code }))
		timer = setTimeout(() => {
			killChild(spawn, child, platform)
			finish({ code: null, timedOut: true })
		}, timeoutMs)
	})
}

const INITIALIZE = {
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: 1,
		capabilities: ['permission', 'namzu/tasks'],
		clientInfo: { name: 'namzu-desktop', version: '0.0.0' },
	},
}

function runInitialize(ctx, args, timeouts) {
	const { spawn, exe, env, cwd, platform } = ctx
	return new Promise((resolve) => {
		let buffer = ''
		let stderr = ''
		let reply
		let done = false
		let replyTimer
		let exitTimer
		let child
		const finish = (result) => {
			if (done) return
			done = true
			clearTimeout(replyTimer)
			clearTimeout(exitTimer)
			resolve(result)
		}
		try {
			child = spawn(exe, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
		} catch (error) {
			return finish({ problem: `could not start: ${error.message}` })
		}
		child.stderr?.on('data', (chunk) => {
			stderr += String(chunk)
		})
		child.stdout?.on('data', (chunk) => {
			buffer += String(chunk)
			for (let at = buffer.indexOf('\n'); at >= 0 && !reply; at = buffer.indexOf('\n')) {
				const line = buffer.slice(0, at)
				buffer = buffer.slice(at + 1)
				let message
				try {
					message = JSON.parse(line)
				} catch {
					continue
				}
				if (message && message.id === 1) {
					reply = message
					clearTimeout(replyTimer)
					// The Desktop closes the engine by ending its input; it must then exit on its own.
					try {
						child.stdin.end()
					} catch {}
					exitTimer = setTimeout(() => {
						killChild(spawn, child, platform)
						finish({ reply, killed: true })
					}, timeouts.exitMs)
				}
			}
		})
		child.on('error', (error) => {
			killChild(spawn, child, platform)
			finish({ problem: `could not start: ${error.message}` })
		})
		child.on('close', (code) =>
			finish(
				reply
					? { reply }
					: { problem: `exited (${code}) before it answered initialize: ${tail(stderr)}` },
			),
		)
		replyTimer = setTimeout(() => {
			killChild(spawn, child, platform)
			finish({
				problem: `did not answer initialize within ${Math.round(timeouts.initializeMs / 1000)} s: ${tail(stderr)}`,
			})
		}, timeouts.initializeMs)
		try {
			child.stdin.on?.('error', () => {})
			child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`)
		} catch {}
	})
}

/**
 * Smoke-test a packed installer tree. `target` is what the installer is for (`{ platform, arch }`),
 * `host` what runs this. Returns `{ skipped: true, reason }`, or `{ failures, report }` where an empty
 * `failures` is a pass.
 *
 * `exe` is the packed Electron executable and `cliDir` the packed `resources/cli`; `natives` are the
 * native package names the staging check found and `requiredFiles` the files it lists as loaded by
 * path (both written by stage-installer.mjs from the same code that ran the staged check).
 */
export async function runPackedSmoke({
	target,
	host = { platform: process.platform, arch: process.arch },
	exe,
	cliDir,
	natives = [],
	requiredFiles = [],
	scratchRoot = tmpdir(),
	spawn = nodeSpawn,
	baseEnv = process.env,
	timeouts = {},
}) {
	if (!runsOn(target, host))
		return {
			skipped: true,
			reason: `this machine is ${host.platform}-${host.arch} and the installer is for ${target.platform}-${target.arch}; the packed program only runs on its own platform, so it was not started`,
		}
	const limits = { ...DEFAULT_TIMEOUTS, ...timeouts }
	const failures = []
	const report = { version: undefined, initialized: false, killedAfterInitialize: false, natives: [...natives] }

	// (4) the files loaded by path.
	for (const file of missingFiles(cliDir, requiredFiles))
		failures.push(`the packed runtime is missing ${file}, which the engine loads by path`)

	if (!existsSync(exe)) {
		failures.push(`the packed program ${exe} does not exist, so the engine could not be started`)
		return { failures, report }
	}
	const bin = join(cliDir, 'dist', 'bin.js')
	if (!existsSync(bin)) {
		failures.push(`the packed runtime has no ${join('dist', 'bin.js')}, so the engine could not be started`)
		return { failures, report }
	}

	const home = mkdtempSync(join(scratchRoot, 'namzu-packed-smoke-'))
	try {
		mkdirSync(join(home, 'namzu'), { recursive: true })
		const ctx = { spawn, exe, env: smokeEnv(home, baseEnv), cwd: cliDir, platform: host.platform }

		// (1) --version prints the version of the CLI's package.json.
		let expected
		try {
			expected = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')).version
		} catch {
			failures.push('the packed runtime has no readable package.json, so its version cannot be checked')
		}
		const version = await runToEnd(ctx, [bin, '--version'], limits.versionMs)
		report.version = version.stdout.trim()
		if (expected !== undefined) {
			if (version.timedOut) failures.push(`the packed engine did not print its version within ${Math.round(limits.versionMs / 1000)} s`)
			else if (version.error) failures.push(`the packed engine could not be started: ${version.error}`)
			else if (version.code !== 0 || !version.stdout.includes(expected))
				failures.push(
					`the packed engine's --version should print ${expected} and exit 0, but it exited ${version.code} and printed "${tail(version.stdout)}" (${tail(version.stderr)})`,
				)
		}

		// (2) acp --desktop answers initialize, then exits when its input ends.
		const init = await runInitialize(ctx, [bin, 'acp', '--desktop'], limits)
		if (init.problem) failures.push(`the packed engine's acp --desktop ${init.problem}`)
		else if (init.reply.error || !init.reply.result)
			failures.push(`the packed engine's acp --desktop answered initialize with ${JSON.stringify(init.reply).slice(0, 300)}`)
		else {
			report.initialized = true
			report.killedAfterInitialize = Boolean(init.killed)
		}

		// (3) the native packages load and do one trivial thing.
		if (natives.length > 0) {
			const probe = await runToEnd(ctx, ['--input-type=module', '-e', probeScript(natives)], limits.probeMs)
			const line = probe.stdout.split('\n').reverse().find((l) => l.startsWith(MARK))
			if (probe.timedOut) failures.push(`the native-binding probe did not finish within ${Math.round(limits.probeMs / 1000)} s`)
			else if (probe.error) failures.push(`the native-binding probe could not be started: ${probe.error}`)
			else if (!line)
				failures.push(`the native-binding probe did not report (exit ${probe.code}): ${tail(probe.stderr)}`)
			else
				for (const bad of JSON.parse(line.slice(MARK.length)))
					failures.push(`the native package ${bad.name} does not work from the packed runtime: ${bad.message}`)
		}
	} finally {
		try {
			rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
		} catch {}
	}
	return { failures, report }
}
