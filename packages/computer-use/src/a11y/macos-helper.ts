import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { type Socket, connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { hasExecutable, runCommand } from '../util/spawn.js'
import type { A11yProcess } from './a11y.js'
import { A11yError } from './interface.js'
import {
	type MacSigningIdentity,
	ensureSigningIdentity,
	macSigningDir,
	unlockSigningKeychain,
} from './macos-signing.js'

/**
 * The macOS accessibility helper: a small Swift app, "Namzu Helper", that
 * LaunchServices starts in the person's own GUI session.
 *
 * Why an app and not a command: macOS gives the Accessibility and Screen
 * Recording permissions to a signed program, and a program started from a
 * terminal or from sshd borrows the terminal's or sshd's (usually none).
 * Started with `open -a`, the helper is its own program, so the person turns
 * two switches on once, for "Namzu Helper", and every later session works.
 *
 * How it is shipped: the Swift source travels in this package
 * (`helper-macos/main.swift`) and is compiled on first use with `swiftc`
 * (Xcode Command Line Tools, which a Mac used for development has) and kept at
 * a stable path, `<NAMZU_HOME>/computer-use/macos/Namzu Helper.app`, which a
 * new build replaces in place (the old app is moved to `replaced/`). It is
 * signed with a per-user local identity (see `macos-signing.ts`) so that the
 * permission the person gave survives every rebuild; on macOS 27 an ad-hoc
 * signature is not trusted at all, and it is used only when the identity
 * cannot be made. A prebuilt binary per architecture would have to be signed
 * with a paid identity to carry a permission across versions and notarised to
 * open without a warning; building on the person's Mac needs neither and
 * makes the binary one that was compiled from the source they can read. The
 * cost is the Command Line Tools and a few seconds the first time (3 to 4
 * seconds on an M-series Mac mini). The socket is keyed by the source's digest,
 * so an old helper still running is left to end by itself (it exits after 15
 * quiet minutes) and never answers a newer client. Nothing needs sudo.
 */

export const MAC_HELPER_NAME = 'Namzu Helper'
export const MAC_HELPER_BUNDLE_ID = 'com.namzu.helper'
const EXECUTABLE = 'NamzuHelper'
/** A unix socket path must be shorter than this on macOS. */
const SOCKET_PATH_LIMIT = 100

/** Variable names never handed to a helper or to the compiler. */
const SECRET_NAME = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i

export interface MacHelperPaths {
	/** `<NAMZU_HOME>/computer-use/macos` */
	readonly root: string
	readonly hash: string
	/** `…/Namzu Helper.app`: one path for every build, so the person's grant keeps pointing at it. */
	readonly bundle: string
	readonly executable: string
	readonly socket: string
	/** Where window captures are written for the client to read; owner only. */
	readonly captures: string
	/** What was built and how it was signed. */
	readonly state: string
	/** Where the local signing identity lives. */
	readonly signing: string
}

export function macHelperSourcePath(): string {
	return fileURLToPath(new URL('../../helper-macos/main.swift', import.meta.url))
}

export function macHelperSourceHash(source: string): string {
	return createHash('sha256').update(source).digest('hex').slice(0, 16)
}

function namzuHome(env: NodeJS.ProcessEnv): string {
	return env.NAMZU_HOME && env.NAMZU_HOME.length > 0 ? env.NAMZU_HOME : join(homedir(), '.namzu')
}

export function macHelperPaths(env: NodeJS.ProcessEnv, hash: string): MacHelperPaths {
	const root = join(namzuHome(env), 'computer-use', 'macos')
	const bundle = join(root, `${MAC_HELPER_NAME}.app`)
	let socket = join(root, `h-${hash.slice(0, 8)}.sock`)
	if (Buffer.byteLength(socket) >= SOCKET_PATH_LIMIT) {
		socket = join(tmpdir(), `namzu-${process.getuid?.() ?? 0}-${hash.slice(0, 8)}`, 'h.sock')
	}
	return {
		root,
		hash,
		bundle,
		executable: join(bundle, 'Contents', 'MacOS', EXECUTABLE),
		socket,
		captures: join(root, 'captures'),
		state: join(root, 'helper-build.json'),
		signing: macSigningDir(root),
	}
}

export function macHelperInfoPlist(hash: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key><string>${MAC_HELPER_BUNDLE_ID}</string>
	<key>CFBundleName</key><string>${MAC_HELPER_NAME}</string>
	<key>CFBundleDisplayName</key><string>${MAC_HELPER_NAME}</string>
	<key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<key>CFBundleVersion</key><string>${hash}</string>
	<key>LSMinimumSystemVersion</key><string>14.0</string>
	<key>LSUIElement</key><true/>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSScreenCaptureUsageDescription</key><string>Namzu reads the windows it is asked to work in, to show them to the model.</string>
</dict>
</plist>
`
}

function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {}
	for (const [name, value] of Object.entries(env)) if (!SECRET_NAME.test(name)) out[name] = value
	return out
}

export interface EnsureMacHelperOptions {
	readonly env: NodeJS.ProcessEnv
	/** Told once, in plain words, before the helper is compiled. */
	readonly onNotice?: (notice: string) => void
	/** For tests. */
	readonly sourcePath?: string
	readonly run?: typeof runCommand
	readonly hasTool?: (name: string) => Promise<boolean>
}

const NO_COMPILER_TEXT =
	'the macOS accessibility helper is built on this Mac the first time, and the Swift compiler is missing. Run `xcode-select --install` once (Xcode Command Line Tools), then try again.'

/** What the last build left, kept beside the app. */
interface BuildState {
	readonly hash: string
	readonly signing: 'identity' | 'adhoc'
	readonly identity?: string
	/** For an ad-hoc build: when to try to make the identity again, ms since the epoch. */
	readonly retryAfter?: number
}

const RETRY_IDENTITY_MS = 24 * 60 * 60 * 1000

function readState(path: string): BuildState | undefined {
	try {
		const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<BuildState>
		if (typeof value.hash !== 'string') return undefined
		return {
			hash: value.hash,
			signing: value.signing === 'identity' ? 'identity' : 'adhoc',
			...(typeof value.identity === 'string' ? { identity: value.identity } : {}),
			...(typeof value.retryAfter === 'number' ? { retryAfter: value.retryAfter } : {}),
		}
	} catch {
		return undefined
	}
}

function writeState(path: string, state: BuildState): void {
	writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 })
}

const NO_IDENTITY_NOTICE = (reason: string): string =>
	`Namzu could not make its local signing identity (${reason.slice(0, 200)}), so the macOS helper is signed ad hoc. macOS 27 does not trust an ad-hoc app even with its switch on, and an older macOS asks for the switches again after every rebuild.`

/**
 * The helper's paths, compiling and signing it first when this source has
 * not been built on this machine. Throws {@link A11yError} (`no_compiler`,
 * `build_failed`) with what the person can do.
 */
export async function ensureMacHelper(options: EnsureMacHelperOptions): Promise<MacHelperPaths> {
	const source = readFileSync(options.sourcePath ?? macHelperSourcePath(), 'utf8')
	const paths = macHelperPaths(options.env, macHelperSourceHash(source))
	const run = options.run ?? runCommand
	const env = cleanEnv(options.env)
	const state = readState(paths.state)
	let identity: MacSigningIdentity | undefined
	if (existsSync(paths.executable) && state?.hash === paths.hash) {
		if (state.signing === 'identity') return paths
		if (Date.now() < (state.retryAfter ?? 0)) return paths
		// Built ad hoc earlier: try the identity again once a day, and rebuild only if it can be made now.
		identity = await ensureSigningIdentity({ root: paths.root, env, run })
		if (!identity) {
			writeState(paths.state, { ...state, retryAfter: Date.now() + RETRY_IDENTITY_MS })
			return paths
		}
	}
	const has = options.hasTool ?? hasExecutable
	const noCompiler = new A11yError('no_compiler', NO_COMPILER_TEXT)
	if (!(await has('swiftc'))) throw noCompiler
	// Without the Command Line Tools /usr/bin/swiftc is still there, as a shim
	// that opens an install dialog, so presence on PATH proves nothing.
	const developerDir = await run('xcode-select', ['-p'], {
		timeoutMs: 5_000,
		env,
	}).catch(() => undefined)
	if (!developerDir || developerDir.exitCode !== 0) throw noCompiler
	options.onNotice?.(
		`Namzu is building its macOS helper (${MAC_HELPER_NAME}) from source, once. It takes a few seconds.`,
	)
	mkdirSync(paths.root, { recursive: true, mode: 0o700 })
	const stage = join(paths.root, `build-${paths.hash}-${process.pid}`)
	const app = join(stage, `${MAC_HELPER_NAME}.app`)
	mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true, mode: 0o700 })
	writeFileSync(join(app, 'Contents', 'Info.plist'), macHelperInfoPlist(paths.hash))
	const compile = await run(
		'swiftc',
		[
			'-O',
			'-swift-version',
			'5',
			options.sourcePath ?? macHelperSourcePath(),
			'-o',
			join(app, 'Contents', 'MacOS', EXECUTABLE),
			'-framework',
			'AppKit',
			'-framework',
			'ApplicationServices',
			'-framework',
			'ScreenCaptureKit',
		],
		{ timeoutMs: 300_000, env },
	)
	if (compile.exitCode !== 0) {
		rmSync(stage, { recursive: true, force: true })
		if (/xcode-select|developer tools/i.test(compile.stderr)) throw noCompiler
		throw new A11yError(
			'build_failed',
			`the macOS helper did not compile: ${compile.stderr.trim().slice(0, 600)}`,
		)
	}
	let why = ''
	identity ??= await ensureSigningIdentity({
		root: paths.root,
		env,
		run,
		onFailure: (reason) => {
			why = reason
		},
	})
	let signedBy: MacSigningIdentity | undefined
	if (identity && (await unlockSigningKeychain(identity, env, run))) {
		const sign = await run(
			'codesign',
			[
				'--force',
				'--keychain',
				identity.keychain,
				'--sign',
				identity.identity,
				'--identifier',
				MAC_HELPER_BUNDLE_ID,
				app,
			],
			{ timeoutMs: 60_000, env },
		)
		if (sign.exitCode === 0) signedBy = identity
		else why = sign.stderr.trim()
	} else if (identity) why = 'the signing keychain would not open'
	if (!signedBy) {
		options.onNotice?.(NO_IDENTITY_NOTICE(why || 'the tools it needs are missing'))
		const sign = await run(
			'codesign',
			['--force', '--sign', '-', '--identifier', MAC_HELPER_BUNDLE_ID, app],
			{ timeoutMs: 60_000, env },
		)
		if (sign.exitCode !== 0) {
			rmSync(stage, { recursive: true, force: true })
			throw new A11yError(
				'build_failed',
				`the macOS helper did not sign: ${sign.stderr.trim().slice(0, 600)}`,
			)
		}
	}
	try {
		// The old app is moved aside, not deleted: a helper still running from it keeps its files.
		if (existsSync(paths.bundle)) {
			const aside = join(paths.root, 'replaced', `${state?.hash ?? 'old'}-${Date.now()}`)
			mkdirSync(aside, { recursive: true, mode: 0o700 })
			renameSync(paths.bundle, join(aside, `${MAC_HELPER_NAME}.app`))
		}
		renameSync(app, paths.bundle)
		writeState(
			paths.state,
			signedBy
				? { hash: paths.hash, signing: 'identity', identity: signedBy.identity }
				: { hash: paths.hash, signing: 'adhoc', retryAfter: Date.now() + RETRY_IDENTITY_MS },
		)
	} catch (error) {
		// Another process finished the same build first.
		if (!existsSync(paths.executable)) throw error
	} finally {
		// This build's own staging folder, nothing else.
		rmSync(stage, { recursive: true, force: true })
	}
	return paths
}

/** Starts the helper through LaunchServices, in the GUI session, without bringing it forward. */
export async function launchMacHelper(
	paths: MacHelperPaths,
	env: NodeJS.ProcessEnv,
	run: typeof runCommand = runCommand,
): Promise<void> {
	const result = await run(
		'open',
		['-g', '-a', paths.bundle, '--args', '--socket', paths.socket, '--build', paths.hash],
		{ timeoutMs: 20_000, env: cleanEnv(env) },
	)
	if (result.exitCode !== 0) {
		throw new A11yError(
			'launch_failed',
			`macOS would not start ${MAC_HELPER_NAME}: ${result.stderr.trim().slice(0, 300) || `exit ${result.exitCode}`}. It must be started from a logged-in desktop session.`,
		)
	}
}

function tryConnect(socketPath: string): Promise<Socket | undefined> {
	return new Promise((resolve) => {
		const socket = connect(socketPath)
		socket.once('connect', () => {
			socket.removeAllListeners('error')
			resolve(socket)
		})
		socket.once('error', () => {
			socket.destroy()
			resolve(undefined)
		})
	})
}

export interface ConnectMacHelperOptions {
	readonly paths: MacHelperPaths
	readonly env: NodeJS.ProcessEnv
	/** How long to wait for a started helper to open its socket, ms. Default 15 000. */
	readonly waitMs?: number
	readonly run?: typeof runCommand
}

/** A connection to the running helper, starting it when nothing listens. */
export async function connectMacHelper(options: ConnectMacHelperOptions): Promise<Socket> {
	const first = await tryConnect(options.paths.socket)
	if (first) return first
	await launchMacHelper(options.paths, options.env, options.run)
	const deadline = Date.now() + (options.waitMs ?? 15_000)
	for (;;) {
		const socket = await tryConnect(options.paths.socket)
		if (socket) return socket
		if (Date.now() > deadline)
			throw new A11yError(
				'helper_not_listening',
				`${MAC_HELPER_NAME} was started but did not open its socket`,
			)
		await new Promise((resolve) => setTimeout(resolve, 150))
	}
}

/** The helper's end of a socket as the client's process interface. Lines written before it is connected wait for it. */
export function socketProcess(open: () => Promise<Socket>): A11yProcess {
	let socket: Socket | undefined
	const queued: string[] = []
	const lineHandlers: ((line: string) => void)[] = []
	const exitHandlers: (() => void)[] = []
	let ended = false
	const end = (): void => {
		if (ended) return
		ended = true
		for (const handler of exitHandlers) handler()
	}
	open().then(
		(connected) => {
			if (ended) {
				connected.destroy()
				return
			}
			socket = connected
			socket.on('error', () => undefined)
			socket.on('close', end)
			createInterface({ input: socket }).on('line', (line) => {
				for (const handler of lineHandlers) handler(line)
			})
			for (const line of queued.splice(0)) socket.write(`${line}\n`)
		},
		() => end(),
	)
	return {
		write: (line) => {
			if (socket) socket.write(`${line}\n`)
			else queued.push(line)
		},
		onLine: (handler) => {
			lineHandlers.push(handler)
		},
		onExit: (handler) => {
			exitHandlers.push(handler)
		},
		kill: () => {
			// Ends this connection; the helper itself stays up for the next session.
			ended = true
			socket?.destroy()
		},
	}
}
