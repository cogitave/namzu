import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CheckDeps, SELF_CHECK_TIMEOUT_TEXT } from './check.js'
import { checkHostAnswer } from './facts.js'
import { messageOf } from './store.js'

/**
 * The self-check of section 5.2 step 8: the unpacked engine is run once, as the app's own
 * program in node mode, and what it says is compared with what the signed description promised.
 *
 * The child gets a clean environment (a short allow-list, never the person's own variables, so
 * no key or token of theirs reaches code that has not been used yet), a temporary home that is
 * removed afterwards, and a time limit. Nothing here touches the person's data.
 */

/** The fields of a child process this check reads; `spawn` satisfies it. */
export interface CheckedChild {
	stdout: NodeJS.ReadableStream | null
	stderr: NodeJS.ReadableStream | null
	stdin: NodeJS.WritableStream | null
	on(event: 'error', listener: (error: Error) => void): unknown
	on(event: 'close', listener: (code: number | null) => void): unknown
	kill(signal?: NodeJS.Signals): unknown
}

export type SpawnChild = (
	program: string,
	args: string[],
	options: {
		cwd: string
		env: NodeJS.ProcessEnv
		stdio: ['pipe', 'pipe', 'pipe']
		windowsHide: true
	},
) => CheckedChild

export interface SelfCheckDeps {
	/** The program that runs the engine: the app's own executable, used as node. */
	program: string
	/** The app's environment; only a short list of names is taken from it. */
	env: NodeJS.ProcessEnv
	/** The methods `initialize` must list. */
	requiredExtensions: readonly string[]
	/** Runs `run` once after `ms`, unless the returned function is called first. */
	after: (ms: number, run: () => void) => () => void
	/** The most one step may take. */
	stepTimeoutMs?: number
	spawn?: SpawnChild
	/** Makes the temporary home and returns its path. */
	makeHome?: () => Promise<string>
	removeHome?: (path: string) => Promise<void>
	/** The version of the app, told to the host at initialize. */
	clientVersion?: string
}

/** Names the engine needs to start at all; everything else is left out. */
const KEEP = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'LANG']

const DEFAULT_STEP_MS = 90_000
const MAX_VERSION_OUTPUT = 64 * 1024
const MAX_INITIALIZE_FRAME = 4 * 1024 * 1024

/** The clean environment: a short allow-list, a home that is not the person's, node mode. */
export function cleanEnvironment(source: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {}
	for (const name of KEEP) if (source[name] !== undefined) env[name] = source[name]
	const temp = join(home, 'tmp')
	return {
		...env,
		HOME: home,
		USERPROFILE: home,
		APPDATA: join(home, 'appdata'),
		LOCALAPPDATA: join(home, 'localappdata'),
		XDG_CONFIG_HOME: join(home, '.config'),
		XDG_DATA_HOME: join(home, '.local', 'share'),
		XDG_CACHE_HOME: join(home, '.cache'),
		TMPDIR: temp,
		TEMP: temp,
		TMP: temp,
		NAMZU_HOME: join(home, 'namzu'),
		CI: 'true',
		ELECTRON_RUN_AS_NODE: '1',
	}
}

const INITIALIZE = (clientVersion: string) =>
	`${JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: 1,
			capabilities: ['permission', 'namzu/tasks'],
			clientInfo: { name: 'namzu-desktop', version: clientVersion },
		},
	})}\n`

type Outcome<T> = { ok: true; value: T } | { ok: false; problem: string }

/** Runs one child until it answers, ends, or the time is up; always stops the child. */
function runStep<T>(
	deps: SelfCheckDeps,
	spawnChild: SpawnChild,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string },
	label: string,
	onData: (
		chunk: string,
		stream: 'stdout' | 'stderr',
		finish: (value: T) => void,
	) => string | undefined,
	onClose: (code: number | null, stderr: string) => Outcome<T>,
): Promise<Outcome<T>> {
	return new Promise((resolve) => {
		let settled = false
		let stderr = ''
		let child: CheckedChild
		const cancel = deps.after(deps.stepTimeoutMs ?? DEFAULT_STEP_MS, () =>
			settle({ ok: false, problem: `${label} ${SELF_CHECK_TIMEOUT_TEXT}` }),
		)
		function settle(outcome: Outcome<T>): void {
			if (settled) return
			settled = true
			cancel()
			try {
				child?.kill('SIGKILL')
			} catch {
				// already gone
			}
			resolve(outcome)
		}
		try {
			child = spawnChild(deps.program, args, {
				cwd: options.cwd,
				env: options.env,
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
			})
		} catch (error) {
			settle({ ok: false, problem: `${label} could not start (${messageOf(error)})` })
			return
		}
		const fail = (problem: string) => settle({ ok: false, problem })
		child.on('error', (error) => fail(`${label} could not start (${messageOf(error)})`))
		child.on('close', (code) => settle(onClose(code, stderr)))
		child.stderr?.on('data', (chunk: Buffer | string) => {
			stderr = (stderr + String(chunk)).slice(-2000)
		})
		child.stdout?.on('data', (chunk: Buffer | string) => {
			const problem = onData(String(chunk), 'stdout', (value) => settle({ ok: true, value }))
			if (problem) fail(problem)
		})
		child.stdin?.on?.('error', () => undefined)
		if (options.stdin !== undefined) child.stdin?.write(options.stdin)
		else child.stdin?.end()
	})
}

export type ProbeResult =
	| { ok: true; versionOutput: string; initialize: unknown }
	| { ok: false; problem: string }

/**
 * Runs an engine twice, as the self-check does (`--version`, then the `initialize` exchange of
 * `acp --desktop`), in a clean environment with a temporary home. Says what it saw, or what went
 * wrong in words for a log. Compares nothing.
 */
export function createProbe(deps: SelfCheckDeps): (entry: string) => Promise<ProbeResult> {
	const spawnChild: SpawnChild =
		deps.spawn ?? ((program, args, options) => spawn(program, args, options))
	const makeHome =
		deps.makeHome ??
		(async () => {
			const home = await mkdtemp(join(tmpdir(), 'namzu-engine-check-'))
			await mkdir(join(home, 'project'), { recursive: true })
			await mkdir(join(home, 'tmp'), { recursive: true })
			// The command line refuses to start when NAMZU_HOME names a folder that is not there.
			await mkdir(join(home, 'namzu'), { recursive: true })
			return home
		})
	const removeHome = deps.removeHome ?? ((path) => rm(path, { recursive: true, force: true }))
	return async (entry) => {
		let home: string
		try {
			home = await makeHome()
		} catch (error) {
			return { ok: false, problem: `could not make a temporary folder (${messageOf(error)})` }
		}
		try {
			const cwd = join(home, 'project')
			const env = cleanEnvironment(deps.env, home)

			let output = ''
			const version = await runStep<string>(
				deps,
				spawnChild,
				[entry, '--version'],
				{ cwd, env },
				'--version',
				(chunk, stream) => {
					if (stream !== 'stdout') return undefined
					output += chunk
					return output.length > MAX_VERSION_OUTPUT ? '--version printed too much' : undefined
				},
				(code, stderr) =>
					code === 0
						? { ok: true, value: output }
						: {
								ok: false,
								problem: `--version ended with ${code === null ? 'no code' : `code ${code}`}${stderr.trim() ? ` (${stderr.trim().slice(-200)})` : ''}`,
							},
			)
			if (!version.ok) return version

			let buffer = ''
			const initialize = await runStep<unknown>(
				deps,
				spawnChild,
				[entry, 'acp', '--desktop'],
				{ cwd, env, stdin: INITIALIZE(deps.clientVersion ?? '0.0.0') },
				'initialize',
				(chunk, _stream, finish) => {
					buffer += chunk
					for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
						const line = buffer.slice(0, at)
						buffer = buffer.slice(at + 1)
						let message: { id?: unknown; result?: unknown; error?: unknown }
						try {
							message = JSON.parse(line)
						} catch {
							continue
						}
						if (message && message.id === 1) {
							if (message.error || message.result === undefined) return 'initialize was refused'
							finish(message.result)
							return undefined
						}
					}
					return buffer.length > MAX_INITIALIZE_FRAME
						? 'initialize answered with too much'
						: undefined
				},
				(code, stderr) => ({
					ok: false,
					problem: `acp --desktop ended (${code === null ? 'no code' : `code ${code}`}) before answering initialize${stderr.trim() ? ` (${stderr.trim().slice(-200)})` : ''}`,
				}),
			)
			if (!initialize.ok) return initialize
			return { ok: true, versionOutput: version.value, initialize: initialize.value }
		} catch (error) {
			return { ok: false, problem: messageOf(error) }
		} finally {
			await removeHome(home).catch(() => undefined)
		}
	}
}

/** The self-check as the check wants it: a problem in words, or undefined when it passed. */
export function createSelfCheck(deps: SelfCheckDeps): CheckDeps['selfCheck'] {
	const probe = createProbe(deps)
	return async ({ entry, expected }) => {
		const seen = await probe(entry)
		if (!seen.ok) return seen.problem
		return checkHostAnswer({
			expected,
			versionOutput: seen.versionOutput,
			initialize: seen.initialize,
			requiredExtensions: deps.requiredExtensions,
		})
	}
}
