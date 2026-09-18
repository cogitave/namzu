/**
 * The PTY slave a terminal has to find before it can report `ready`.
 *
 * `handleTerminal` spawns util-linux `script` and then walks `/proc` for the
 * shell it forked, because three things need the REAL slave: the `stty -F`
 * that sets the window size (that is the TIOCSWINSZ ioctl, which is what
 * raises the SIGWINCH programs expect), the pid whose kernel session the
 * teardown signals, and the fact that no pipe is ever mistaken for a
 * terminal. The walk used `readlink('/proc/<pid>/fd/0')` and nothing else
 * (#512).
 *
 * That probe is a PRIVILEGE. `/proc/<pid>/fd` is `dr-x------` owned by the
 * target, and answering a readlink from it is `ptrace_may_access`, which
 * refuses a reader whose credentials do not match the target's — the one
 * axis that differs between a guest that runs the agent as root and one that
 * drops it to an unprivileged uid. `/proc/<pid>/stat` is world readable and
 * carries `tty_nr`, the kernel's own record of the controlling terminal, so
 * the second probe does not depend on that privilege at all.
 *
 * The cases are arranged differently on purpose: a test that mocks the
 * failing probe proves the mock.
 *
 *  - **fd 0 IS the PTY.** The shape every release before this one shipped,
 *    and it has to keep behaving byte for byte: ready, the slave the fd 0
 *    probe named, and the shell's own session still the unit a teardown
 *    signals.
 *  - **fd 0 is REFUSED.** A setgid copy of `/bin/sh` runs with an egid this
 *    process is not in, so the kernel denies the readlink with EACCES while
 *    `/proc/<pid>/stat` still reads. That is the reporter's shape, in a real
 *    guest-kernel denial rather than a stub, and the case asserts the denial
 *    is real before it asserts anything about the agent. It stands down, out
 *    loud, on a machine that cannot produce it — no second group to give the
 *    binary, or a `nosuid` filesystem that drops the bit.
 *  - **fd 0 answers, with something that is not a PTY.** Arranged at the
 *    seam, because the real arrangement is a RACE the walk wins: `script`'s
 *    child always starts with the slave on fd 0, and a measured poll shows it
 *    there within a millisecond of the fork and replaced by the shell's own
 *    `exec 0</dev/null` only after — so the shell's redirect is normally too
 *    late for the old walk to see, which is exactly why this branch has to be
 *    driven at the seam to be pinned at all.
 *  - **Neither probe can answer.** The same seam, denying `readlink` for
 *    `/proc/<pid>/fd/0` and `readFile` for `/proc/<pid>/stat`, and releasing
 *    `/proc/<script>` on the eleventh observation of it rather than from the
 *    start: this pins the message and the early stop, and it has to be seamed
 *    because a REAL release is a terminal whose host gets its `exit` frame
 *    and never sees this error at all (`handleTerminal` hands the outcome to
 *    the child's own `close` handler the moment the child has exited). The
 *    release is late rather than immediate for the same reason the other
 *    cases wait: the tree this one is about has to be a tree first — the
 *    shell forked and its job backgrounded — or the teardown it proves is
 *    the teardown of nothing.
 *  - **The program ends before the slave is found.** Both probes refused
 *    against a shell that exits fifty milliseconds in: the host gets the
 *    `exit` frame its own program earned, not a walk error about a terminal
 *    that had already ended. It is the only case here that ends in `exit`
 *    rather than `ready` or `error`. It pins the FRAME and not the reason —
 *    `/proc/<script>` going away and node reaping the child are one event
 *    seen from two sides, but the `close` handler that writes that frame runs
 *    a tick later, and measured, it wins that race on its own: this case
 *    passes with `handleTerminal`'s deferral to it removed as well. What the
 *    deferral does is close the window where it does not win.
 *
 * Two things are checked in every case that comes up, because they are the
 * contract this change cannot break. The slave is compared against the real
 * pty by resizing and reading the window size back OUT of that pty's line
 * discipline — a wrong path would set the size of something else, and no
 * path at all would set nothing. And the pid that comes back with the slave
 * is checked by the only thing that can check it: a job backgrounded with
 * `&`, ignoring SIGHUP, which nothing but the SHELL'S OWN KERNEL SESSION can
 * reach — the unit `readUnixSessionId(pty.shellPid)` feeds the teardown.
 *
 * The tree is the other contract, and the two cases that drive the FAILING
 * walk assert it as well: a terminal that never comes up still owes its host
 * a tree that goes. What the agent can reach on that path is `script`'s
 * process group and nothing more — the shell's kernel session is exactly what
 * it failed to find — so a job that ignores SIGHUP is left running, which
 * this file states rather than closes. The agent's failure-path kill is
 * unawaited by design (an agent that lives on does not need to wait for it),
 * so the cleanup these cases depend on is their own: the reap in `afterEach`.
 */

import { spawnSync } from 'node:child_process'
import {
	chmodSync,
	chownSync,
	copyFileSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { type AddressInfo, type Server, type Socket, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AGENT_ENV_KEYS } from './fixtures/agent-env.js'
import { decodeFrames, encodeFrame } from './fixtures/framed-agent-client.js'

const IS_WINDOWS = process.platform === 'win32'
const require_ = createRequire(import.meta.url)
const AGENT_PATH = '../../../../agent/agent.cjs'

/** A pod uid is what the downward API actually delivers; shaped like one. */
const POD_UID = '3d9a51c7-08b2-4e6f-9a41-2c5d7e8f0b13'

const SIZE = { cols: 80, rows: 24 }
const RESIZED = { cols: 100, rows: 40 }
const SLAVE_PATH = /^\/dev\/pts\/\d+$/
const DEV_PTS_MAJOR = 136

/**
 * A shell that keeps the PTY as its controlling terminal.
 *
 * The `exec` at the end keeps the pid — the shell is REPLACED, not forked —
 * so the pid `script` forked is still there to be found however long a case
 * takes. `echo` reports the job's pid on the terminal's own stream, the way
 * a host would learn it.
 */
const JOB = "(trap '' HUP; exec sleep 300) & echo JOBPID $!; exec sleep 300"

interface AgentModule {
	startListening(): Promise<Server>
}

interface TerminalStream {
	/** Everything the terminal has printed so far. */
	text(): string
	/**
	 * The `ready` or the `error` — and NOT necessarily the first frame on the
	 * wire. `handleTerminal` attaches the output forwarders to `script`
	 * before it goes looking for the slave, so a shell that prints inside its
	 * first millisecond has its `data` frames on the socket before the
	 * outcome is decided. Asserting on the first frame would read one of
	 * those and call it the terminal's answer.
	 */
	outcome(): Record<string, unknown>
	/** The text of the error frame, or nothing when the terminal came up. */
	error(): string | undefined
	/**
	 * The `exit` frame, or nothing when the terminal has not ended.
	 *
	 * An outcome like the other two, and for a terminal whose program ends
	 * before the slave is found it is the ONLY one: that is what the last
	 * case is about, and a case that had to wait for the close instead could
	 * not tell an exit from a silent teardown.
	 */
	ended(): Record<string, unknown> | undefined
	resize(size: { cols: number; rows: number }): void
	close(): void
}

let workDir: string
let listener: Server | undefined
let agentPort = 0
let agent: AgentModule
const sockets: Socket[] = []
let saved: Record<string, string | undefined>

function clearEnv(): void {
	for (const key of AGENT_ENV_KEYS) delete process.env[key]
}

/** Load a FRESH agent module, so module-level registry state never leaks. */
function loadAgent(): AgentModule {
	delete require_.cache[require_.resolve(AGENT_PATH)]
	return require_(AGENT_PATH) as AgentModule
}

/**
 * Dial the terminal op and keep the connection.
 *
 * Unlike the request/response helper beside it, this one cannot read until
 * close: a terminal answers `ready` and then stays open for as long as the
 * case needs it, which is the window the slave had to have been found by.
 */
function openTerminal(body: Record<string, unknown>): Promise<TerminalStream> {
	return new Promise<TerminalStream>((resolve, reject) => {
		const socket = connect({ host: '127.0.0.1', port: agentPort })
		sockets.push(socket)
		let printed = ''
		let rest: Buffer = Buffer.alloc(0)
		let answered: Record<string, unknown> | undefined
		let ended: Record<string, unknown> | undefined
		let arrived: () => void = () => {}
		const outcome = new Promise<void>((resolveOutcome) => {
			arrived = resolveOutcome
		})
		const timer = setTimeout(() => reject(new Error('the terminal never answered')), 10_000)
		timer.unref()
		socket.on('connect', () => {
			socket.write(encodeFrame(JSON.stringify({ op: 'terminal', token: POD_UID, body })))
		})
		socket.on('data', (chunk) => {
			const decoded = decodeFrames(rest.length === 0 ? chunk : Buffer.concat([rest, chunk]))
			rest = decoded.rest
			for (const payload of decoded.frames) {
				if (payload.length === 0) continue
				const frame = JSON.parse(payload) as Record<string, unknown>
				if (frame.type === 'data' && typeof frame.data === 'string') printed += frame.data
				if (answered === undefined && (frame.type === 'ready' || frame.type === 'error')) {
					answered = frame
					arrived()
				}
				// Resolved on too: a terminal whose program ended before its
				// slave was found is answered by this frame and by nothing
				// else, and a case that waited for the close would be reading
				// a silence it cannot interpret.
				if (ended === undefined && frame.type === 'exit') {
					ended = frame
					arrived()
				}
			}
		})
		socket.on('error', reject)
		// A terminal that failed to come up has already written its error frame
		// and ended; this only unblocks a host that got nothing at all, which
		// leaves `outcome()` empty and every assertion below failing.
		socket.on('close', () => arrived())
		outcome
			.then(() => {
				clearTimeout(timer)
				resolve({
					text: () => printed,
					outcome: () => answered ?? {},
					error: () => {
						const error = answered?.error
						return typeof error === 'string' ? error : undefined
					},
					ended: () => ended,
					resize: (size) => {
						socket.write(
							encodeFrame(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows })),
						)
					},
					close: () => socket.destroy(),
				})
			})
			.catch(reject)
	})
}

/** The pids one process has spawned directly, from `/proc`. */
function childrenOf(pid: number): number[] {
	try {
		return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map(Number)
	} catch {
		return []
	}
}

/** The name the kernel has for one pid's program, or nothing when it is gone. */
function commandNameOf(pid: number): string | undefined {
	try {
		return readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
	} catch {
		return undefined
	}
}

/**
 * The `script` this terminal just started: the one new child that is `script`.
 *
 * By NAME rather than by being the only new child, because this process is
 * the parent of every `stty` the agent spawns to resize a pty and the two
 * spawns are milliseconds apart. A case that takes its pids before the
 * terminal is up — which the failure cases have to, since their walk gives
 * up in the same breath as the error frame — would otherwise catch a `stty`
 * and call it `script`.
 */
async function newChild(before: number[], timeoutMs = 5_000): Promise<number> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const fresh = childrenOf(process.pid).filter(
			(pid) => !before.includes(pid) && commandNameOf(pid) === 'script',
		)
		if (fresh.length === 1) return fresh[0] as number
		if (Date.now() > deadline) {
			throw new Error(`expected exactly one new script, saw [${fresh.join(', ')}]`)
		}
		await delay(10)
	}
}

/** The first child one pid has forked, waiting until the fork has happened. */
async function firstChildOf(pid: number, timeoutMs = 5_000): Promise<number> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const [child] = childrenOf(pid)
		if (child !== undefined) return child
		if (Date.now() > deadline) throw new Error(`no child appeared under ${pid}`)
		await delay(10)
	}
}

/** What one pid's `fd/<n>` names, or the errno that stopped it being read. */
function fdTarget(pid: number, fd: number): { target?: string; code?: string } {
	try {
		return { target: readlinkSync(`/proc/${pid}/fd/${fd}`) }
	} catch (error) {
		return { code: (error as { code?: string }).code }
	}
}

/** The slave `/proc/<pid>/stat` names as the pid's controlling terminal. */
function controllingSlave(pid: number): string | undefined {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
		const ttyNr = Number(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[4])
		const major = (ttyNr & 0xfff00) >> 8
		const minor = (ttyNr & 0xff) | ((ttyNr >> 12) & 0xfff00)
		return major === DEV_PTS_MAJOR ? `/dev/pts/${minor}` : undefined
	} catch {
		return undefined
	}
}

/** What a pty's own line discipline reports its window size as. */
function ptySize(slavePath: string): string {
	const result = spawnSync('/usr/bin/stty', ['-F', slavePath, 'size'], { encoding: 'utf8' })
	return result.status === 0 ? result.stdout.trim() : `stty refused: ${result.stderr.trim()}`
}

/** Wait for a resize to land, rather than guessing at one delay. */
async function waitForPtySize(slavePath: string, size: string, timeoutMs = 5_000): Promise<string> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const saw = ptySize(slavePath)
		if (saw === size || Date.now() > deadline) return saw
		await delay(25)
	}
}

/** Whether a pid is a live process. A zombie reads as gone. */
function isAlive(pid: number): boolean {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
		return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'
	} catch {
		return false
	}
}

/** One terminal's pids, as the case that started it learned them. */
interface TerminalTree {
	/** util-linux `script`, the only pid a failed walk knows a group for. */
	script: number
	/** The shell `script` forked, in the kernel session of its own. */
	shell: number
	/** A job that shell backgrounded, where the case runs one. */
	job?: number
}

/**
 * Every tree a case started, so none of them outlives the run.
 *
 * Registering is what makes the cleanup the test's own. The agent's
 * failure-path kill is `void signalSessionProcesses(...)` — not awaited, by
 * design, because the agent it runs in outlives every terminal — and a
 * vitest worker that ends first takes the pending `/proc` scan with it,
 * leaving `script` and everything under it running with no terminal and no
 * op that reaches it.
 */
const trees: TerminalTree[] = []

/** One pid's children, and theirs, to any depth. */
function descendantsOf(pid: number): number[] {
	const found: number[] = []
	for (const child of childrenOf(pid)) found.push(child, ...descendantsOf(child))
	return found
}

/**
 * Kill one tree outright, whether or not the case got to the end of it.
 *
 * SIGKILL, because nothing gentler is a promise: the job these cases
 * background ignores SIGHUP on purpose, and it sits in the shell's own
 * session — which is precisely the unit a failed walk never learned, so
 * neither the agent's `/proc` scan nor its process-group kill reaches it.
 */
function reapTree(tree: TerminalTree): void {
	const pids = new Set<number>([tree.script, tree.shell])
	if (tree.job !== undefined) pids.add(tree.job)
	for (const pid of [...pids]) for (const child of descendantsOf(pid)) pids.add(child)
	for (const pid of pids) {
		if (!isAlive(pid)) continue
		try {
			process.kill(pid, 'SIGKILL')
		} catch {
			// It went between the check and the call.
		}
	}
}

/** Whatever a case started, killed whether or not its assertions got that far. */
function reapTrees(): void {
	for (const tree of trees.splice(0)) reapTree(tree)
}

/**
 * Wait for a tree to stop running, and answer whatever is still up.
 *
 * A zombie counts as GONE, as it does in every other liveness check in this
 * file: what is asserted is that nothing is still RUNNING, and a reparented
 * pid sits as a zombie for exactly as long as the init that inherited it
 * takes to reap it. The budget is a second, which is generous for a signal
 * the agent has already sent — and a leaking tree does not go in a minute,
 * let alone in one.
 */
async function waitsForTreeGone(pids: number[], timeoutMs = 1_000): Promise<number[]> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const alive = pids.filter((pid) => isAlive(pid))
		if (alive.length === 0 || Date.now() > deadline) return alive
		await delay(10)
	}
}

/**
 * The shell's own session, proved by the only thing that proves it.
 *
 * The job ignores SIGHUP, so the PTY hanging up cannot end it and neither can
 * the process group of `script` — the shell is in a session of its own. What
 * is left is the `/proc` scan over the kernel session ids the terminal
 * recorded, which is `readUnixSessionId(pty.shellPid)` and nothing else. A
 * slave that came back without the right pid still resizes fine; this is the
 * assertion that catches it.
 */
async function provesSessionTeardown(terminal: TerminalStream): Promise<void> {
	const match = await (async () => {
		const deadline = Date.now() + 5_000
		for (;;) {
			const found = /JOBPID (\d+)/.exec(terminal.text())
			if (found) return found
			if (Date.now() > deadline) {
				throw new Error(`the shell never reported its job; saw ${JSON.stringify(terminal.text())}`)
			}
			await delay(10)
		}
	})()
	const job = Number(match[1])
	expect(isAlive(job)).toBe(true)
	terminal.close()
	const deadline = Date.now() + 5_000
	while (isAlive(job) && Date.now() < deadline) await delay(25)
	expect(isAlive(job)).toBe(false)
}

/**
 * A copy of `/bin/sh` whose egid is a group this process is NOT in.
 *
 * A file's group can only be set to a group its owner belongs to, so the
 * group comes from this process's own supplementary list — and a machine
 * where the caller has no second group cannot make this arrangement at all,
 * which the case reports rather than works around. The setgid bit survives
 * only where the filesystem is not `nosuid`, which is the second way the
 * arrangement can fail to take. Both are checked on the denial itself,
 * before anything is asserted about the agent.
 */
function setgidShell(dir: string): { path: string; gid: number } | undefined {
	const gid = (process.getgroups?.() ?? []).find((group) => group !== process.getgid?.())
	if (gid === undefined) return undefined
	const path = join(dir, 'setgid-sh')
	try {
		copyFileSync('/bin/sh', path)
		chmodSync(path, 0o755)
		chownSync(path, -1, gid)
		chmodSync(path, 0o2755)
		const stat = statSync(path)
		// `2755 <gid>` is the arrangement. Anything else means the chown or the
		// setgid bit did not take, and the case must not pretend it did.
		return (stat.mode & 0o7777) === 0o2755 && stat.gid === gid ? { path, gid } : undefined
	} catch {
		return undefined
	}
}

/** The `/proc` paths the walk reads, and nothing else. */
const FD_ZERO = /^\/proc\/\d+\/fd\/0$/
const PROC_STAT = /^\/proc\/\d+\/stat$/
const PROC_DIR = /^\/proc\/(\d+)$/

/** A node errno with the code the walk reports. */
function errno(code: string, path: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: proc read refused, ${path}`), { code, path })
}

interface PatchedFs {
	readlink: (...args: unknown[]) => Promise<unknown>
	readFile: (...args: unknown[]) => Promise<unknown>
	stat: (...args: unknown[]) => Promise<unknown>
}

interface Seams {
	/** Fail `readlink('/proc/<pid>/fd/0')` the way a denied read fails. */
	denyFdZero(): void
	/** Answer `readlink('/proc/<pid>/fd/0')` with something that is not a PTY. */
	answerFdZeroAs(path: string): void
	/** Fail `readFile('/proc/<pid>/stat')` the same way a denial does. */
	denyProcStat(): void
	/**
	 * Answer `stat('/proc/<pid>')` for the first `afterObservations` reads of
	 * that pid and report it released on every read after — a pid the kernel
	 * lets go of mid-walk, and a walk that has to stop on the read that says
	 * so rather than on the end of its budget.
	 */
	hideProcEntries(afterObservations: number): void
	restore(): void
}

/**
 * The seams above, taken on `node:fs/promises` the agent holds.
 *
 * The agent requires that module at load, so the object patched here IS the
 * one its calls go through. Each patch answers only for the exact `/proc`
 * paths it names — a workspace read, a `readdir` or the terminal's own
 * `mkdir` is passed straight to the original — and `restore` puts every one
 * back, because the module is shared with the rest of this suite.
 */
function seams(): Seams {
	const fsp = require_('node:fs/promises') as unknown as PatchedFs
	const original = { readlink: fsp.readlink, readFile: fsp.readFile, stat: fsp.stat }
	let deniedFd = false
	let answeredFd: string | undefined
	let deniedStat = false
	let hiddenAfter: number | undefined
	const observed = new Map<number, number>()
	fsp.readlink = async (...args: unknown[]) => {
		const path = String(args[0])
		if (FD_ZERO.test(path)) {
			if (deniedFd) throw errno('EACCES', path)
			if (answeredFd !== undefined) return answeredFd
		}
		return await original.readlink(...args)
	}
	fsp.readFile = async (...args: unknown[]) => {
		const path = String(args[0])
		if (deniedStat && PROC_STAT.test(path)) throw errno('EACCES', path)
		return await original.readFile(...args)
	}
	fsp.stat = async (...args: unknown[]) => {
		const path = String(args[0])
		const after = hiddenAfter
		if (after !== undefined) {
			const entry = PROC_DIR.exec(path)
			if (entry) {
				const pid = Number(entry[1])
				const seen = (observed.get(pid) ?? 0) + 1
				observed.set(pid, seen)
				if (seen > after) throw errno('ENOENT', path)
			}
		}
		return await original.stat(...args)
	}
	return {
		denyFdZero: () => {
			deniedFd = true
		},
		answerFdZeroAs: (path) => {
			answeredFd = path
		},
		denyProcStat: () => {
			deniedStat = true
		},
		hideProcEntries: (afterObservations) => {
			hiddenAfter = afterObservations
		},
		restore: () => {
			fsp.readlink = original.readlink
			fsp.readFile = original.readFile
			fsp.stat = original.stat
		},
	}
}

beforeEach(async () => {
	saved = Object.fromEntries(AGENT_ENV_KEYS.map((key) => [key, process.env[key]]))
	workDir = mkdtempSync(join(tmpdir(), 'namzu-pty-'))
	clearEnv()
	process.env.NAMZU_AGENT_TCP_PORT = '0'
	process.env.NAMZU_AGENT_BIND_TOKEN = POD_UID
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
	agent = loadAgent()
	listener = await agent.startListening()
	agentPort = (listener.address() as AddressInfo).port
})

afterEach(async () => {
	// First, and unconditionally: whatever a case proved about its tree, it
	// does not get to leave one behind.
	reapTrees()
	for (const socket of sockets) socket.destroy()
	sockets.length = 0
	if (listener) {
		listener.close()
		listener = undefined
	}
	clearEnv()
	for (const [key, value] of Object.entries(saved)) {
		if (value !== undefined) process.env[key] = value
	}
	rmSync(workDir, { recursive: true, force: true })
})

describe.skipIf(IS_WINDOWS)('finding the PTY slave of a terminal', () => {
	it('keeps the fd 0 answer, and the same session, where fd 0 IS the PTY', async () => {
		const before = childrenOf(process.pid)
		const opening = openTerminal({
			...SIZE,
			command: '/bin/sh',
			args: ['-c', JOB],
			env: {},
		})
		const script = await newChild(before)
		const shell = await firstChildOf(script)
		const job = await firstChildOf(shell)
		trees.push({ script, shell, job })
		const terminal = await opening

		const slave = fdTarget(shell, 0).target
		expect(slave).toMatch(SLAVE_PATH)
		expect(terminal.error()).toBeUndefined()
		expect(terminal.outcome()).toMatchObject({ type: 'ready' })
		terminal.resize(RESIZED)
		expect(await waitForPtySize(slave as string, '40 100')).toBe('40 100')
		await provesSessionTeardown(terminal)
	}, 20_000)

	it('finds it when the kernel refuses /proc/<pid>/fd/0 outright', async (context) => {
		const arrangement = setgidShell(workDir)
		if (arrangement === undefined) {
			context.skip('this machine has no second group to give the target')
			return
		}
		const before = childrenOf(process.pid)
		const opening = openTerminal({
			...SIZE,
			command: arrangement.path,
			// `-p` is load-bearing: a non-interactive shell without it
			// RESETS its egid to the real one, which would unmake the whole
			// arrangement before the first probe. Measured on dash: without
			// it the process comes back `Gid: 1000 1000 1000 1000` and fd 0
			// reads; with it, `Gid: 1000 998 998 998` and fd 0 is EACCES.
			args: ['-p', '-c', JOB],
			env: {},
		})
		const script = await newChild(before)
		const shell = await firstChildOf(script)
		trees.push({ script, shell, job: await firstChildOf(shell) })
		const terminal = await opening

		// Proof the denial is real, from this process, of this uid, against
		// this very pid: the readlink the walk used to depend on cannot be
		// answered at all, while `/proc/<pid>/stat` still reads and still
		// names the slave. A machine that cannot produce the denial stands
		// down here rather than passing this case for the wrong reason.
		const refused = fdTarget(shell, 0)
		if (refused.code !== 'EACCES') {
			context.skip(`the setgid arrangement did not take (fd/0 read as ${String(refused.target)})`)
			return
		}
		const slave = controllingSlave(shell)
		expect(slave).toMatch(SLAVE_PATH)

		expect(terminal.error()).toBeUndefined()
		expect(terminal.outcome()).toMatchObject({ type: 'ready' })
		terminal.resize(RESIZED)
		expect(await waitForPtySize(slave as string, '40 100')).toBe('40 100')
		// The fallback's pid is the one the fd 0 probe would have named:
		// the shell, whose session is the unit the teardown signals.
		await provesSessionTeardown(terminal)
	}, 20_000)

	it('prefers the controlling terminal when fd 0 answers with something else', async () => {
		const before = childrenOf(process.pid)
		const patch = seams()
		try {
			// Every candidate answers `/dev/null` on fd 0 — what the shell
			// would have produced had its own redirect beaten the walk.
			patch.answerFdZeroAs('/dev/null')
			const opening = openTerminal({
				...SIZE,
				command: '/bin/sh',
				args: ['-c', JOB],
				env: {},
			})
			const script = await newChild(before)
			const shell = await firstChildOf(script)
			trees.push({ script, shell, job: await firstChildOf(shell) })
			const terminal = await opening
			// The seam covers `/proc/<pid>/fd/0` only, so fd 1 is still the
			// kernel's own answer and the slave this must land on is known
			// independently of the probe under test.
			const slave = fdTarget(shell, 1).target
			expect(slave).toMatch(SLAVE_PATH)

			expect(terminal.error()).toBeUndefined()
			expect(terminal.outcome()).toMatchObject({ type: 'ready' })
			terminal.resize(RESIZED)
			expect(await waitForPtySize(slave as string, '40 100')).toBe('40 100')
			await provesSessionTeardown(terminal)
		} finally {
			patch.restore()
		}
	}, 20_000)

	it('names every probe it could not read when no slave can be found', async () => {
		const patch = seams()
		try {
			patch.denyFdZero()
			patch.denyProcStat()
			// The tree is taken before the error frame rather than after it.
			// The walk fails only when its budget is gone, and the kill that
			// follows the error frame is issued in the same breath: the pids
			// are a child of this process for a millisecond, and a reaped pid
			// after that.
			const before = childrenOf(process.pid)
			const opening = openTerminal({
				...SIZE,
				command: '/bin/sh',
				args: ['-c', 'exec sleep 300'],
				env: {},
			})
			const script = await newChild(before)
			const shell = await firstChildOf(script)
			const tree: TerminalTree = { script, shell }
			trees.push(tree)
			const terminal = await opening

			const error = terminal.error()
			expect(error).toBeDefined()
			// The phrase anything matching on this error already matches on.
			expect(error?.startsWith('terminal PTY slave did not appear')).toBe(true)
			// And the facts that make it actionable: both probes refused,
			// with the errno, over the whole budget, with `script` alive.
			expect(error).toMatch(/last fd\/0: EACCES/)
			expect(error).toMatch(/last stat: EACCES/)
			expect(error).toMatch(/script: alive/)
			expect(error).toMatch(/200 attempts, \d+ms/)

			// And the contract the error frame is not: the tree goes. The
			// agent's kill on this path is not awaited, so this is the wait
			// that lets it land — and `afterEach` reaps the tree if it does
			// not, which is what keeps a regression here from leaving a
			// terminal running behind the suite.
			expect(await waitsForTreeGone([script, shell])).toEqual([])
		} finally {
			patch.restore()
		}
	}, 20_000)

	it('stops looking as soon as `script` is gone', async () => {
		const patch = seams()
		try {
			patch.denyFdZero()
			patch.denyProcStat()
			// `script` is released on the ELEVENTH observation of its entry,
			// not at 0ms: the tree has to be a tree before this can assert
			// anything about its teardown — `script` forked, the shell it
			// forked, and the job that shell backgrounded — and a release at
			// 0ms beats all three of them.
			patch.hideProcEntries(10)
			const before = childrenOf(process.pid)
			const opening = openTerminal({
				...SIZE,
				command: '/bin/sh',
				args: ['-c', JOB],
				env: {},
			})
			const script = await newChild(before)
			const shell = await firstChildOf(script)
			const job = await firstChildOf(shell)
			trees.push({ script, shell, job })
			const terminal = await opening

			const error = terminal.error()
			expect(error).toBeDefined()
			expect(error).toMatch(/script: gone/)
			// The whole budget spent against a pid the kernel has released is
			// what this replaces: the walk stops on the observation that said
			// gone — the eleventh — and not on the two hundredth.
			expect(Number(/\((\d+) attempts/.exec(error ?? '')?.[1] ?? '9999')).toBe(11)
			expect(Number(/, (\d+)ms;/.exec(error ?? '')?.[1] ?? '9999')).toBeLessThan(200)

			// The same teardown contract as the case above, on the path where
			// the agent knows the LEAST: `script` and its process group. The
			// shell goes with the PTY hanging up — its job ignoring SIGHUP is
			// what the failure path cannot end, because the session that
			// reaches it is the thing the walk failed to find.
			expect(await waitsForTreeGone([script, shell])).toEqual([])
			expect(isAlive(job)).toBe(true)
		} finally {
			patch.restore()
		}
	}, 20_000)

	it('answers a program that exits first with its own exit frame', async () => {
		const patch = seams()
		try {
			// Both probes refused, so the walk can never answer — and the
			// program it is looking for ends fifty milliseconds in. The walk
			// gives up on the same fact that ends the terminal, which is the
			// one shape where a walk error would be a claim about a terminal
			// that had already ended, and would lose the exit code with it.
			patch.denyFdZero()
			patch.denyProcStat()
			const before = childrenOf(process.pid)
			const opening = openTerminal({
				...SIZE,
				command: '/bin/sh',
				args: ['-c', 'exec sleep 0.05'],
				env: {},
			})
			const script = await newChild(before)
			const shell = await firstChildOf(script)
			trees.push({ script, shell })
			const terminal = await opening

			expect(terminal.error()).toBeUndefined()
			expect(terminal.outcome()).toEqual({})
			expect(terminal.ended()).toMatchObject({ type: 'exit', exitCode: 0 })
			expect(await waitsForTreeGone([script, shell])).toEqual([])
		} finally {
			patch.restore()
		}
	}, 20_000)
})
