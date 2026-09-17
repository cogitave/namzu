/**
 * `../entrypoint.sh`: POSIX-sh parse checks, plus its actual mount/format/
 * drop-privilege LOGIC exercised with PATH-shimmed `blkid`, `dd`,
 * `mkfs.ext4`, `mount`, `chown` and `setpriv` — never the real tools, so
 * this suite needs no root and is safe in the default `pnpm test` tier the
 * rest of this package's suites already run in.
 *
 * The one case this file exists for above all others: a device that
 * ALREADY carries a filesystem must be mounted WITHOUT calling `mkfs` —
 * see entrypoint.sh's own header comment for why an unconditional `mkfs`
 * there would be the single most destructive possible bug in this whole
 * backend (it would erase a resumed workspace's disk on every boot). Close
 * behind it: a `blkid` that is missing, unexecutable, or failing for any
 * reason other than "no filesystem found" (status 2) must abort the pod
 * rather than be mistaken for "the device is empty" — see the exit-status
 * cases inside "a workspace device is configured" below, which use
 * `runEntrypoint`'s `fakes`/`basePath` options to prove a tool is truly
 * unreachable, not merely made to fail.
 *
 * The `-b` (is-a-block-device) check in the script is real, unshimmed
 * shell — `[` is a POSIX regular built-in and is checked before `PATH` is
 * even searched, so no PATH shim can fake it. Rather than requiring real
 * privilege to create a block-special file (`mknod` needs `CAP_MKNOD`),
 * these cases point `NAMZU_WORKSPACE_DEVICE` at a real, already-existing
 * block device node any unprivileged user can `stat()` — `/dev/loop0`..`7`
 * on the Linux CI runner this repo's own `.github/workflows/ci.yml` uses
 * (a `ubuntu-latest` job has them; a machine with none skips those cases
 * rather than failing on an environment quirk). Every tool that would ever touch
 * it for real is shimmed, so nothing is opened, read, written or attached —
 * only its path is ever passed to a script that just logs its own argv.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRYPOINT_PATH = join(HERE, '../entrypoint.sh')
const ENTRYPOINT_SOURCE = readFileSync(ENTRYPOINT_PATH, 'utf8')

// An absolute path, not a bare command name: `runEntrypoint` lets a case
// override the PATH the SCRIPT searches (to prove a tool is truly absent),
// and Node resolves a bare command through that same overridden PATH before
// it can even start the process — so spawning `sh` by name would fail to
// launch at all once a case sets a PATH with no `sh` on it. Resolving the
// interpreter once, up front, via the real environment keeps those two
// concerns (what launches the script vs. what the script itself can find)
// independent.
const SH_BIN = existsSync('/bin/sh') ? '/bin/sh' : '/usr/bin/sh'

function hasCommand(name: string): boolean {
	const result = spawnSync('sh', ['-c', `command -v ${name}`])
	return result.status === 0
}

/** The first `/dev/loopN` this user can `stat()` as a block device, if any. */
function findLoopDevice(): string | undefined {
	for (let n = 0; n < 8; n++) {
		const candidate = `/dev/loop${n}`
		const result = spawnSync('sh', ['-c', `test -b ${candidate}`])
		if (result.status === 0) return candidate
	}
	return undefined
}

const LOOP_DEVICE = findLoopDevice()

const FAKE_TOOLS: Record<string, string> = {
	// The default (root) so every EXISTING case in this file — none of which
	// override `id` — keeps taking the root branch, whatever uid the process
	// actually running this test suite happens to be. A case testing the
	// non-root branch overrides this with `fakeId(<non-zero>)` in its own
	// `fakes` map.
	id: fakeId(0),
	// `FAKE_BLKID_TYPE` set: prints that type and exits 0 (a filesystem was
	// found). Otherwise exits `FAKE_BLKID_EXIT` (default 2, "nothing
	// found" — blkid(8) — matching the real tool's answer for a genuinely
	// blank device). `FAKE_BLKID_STDERR`, when set, is written to stderr
	// first, standing in for whatever real blkid would have said there —
	// e.g. the shell's own "not found" for an unexecutable blkid.
	blkid: `#!/bin/sh
echo "blkid $*" >> "$NAMZU_TEST_LOG"
if [ -n "\${FAKE_BLKID_STDERR:-}" ]; then
  echo "$FAKE_BLKID_STDERR" >&2
fi
if [ -n "\${FAKE_BLKID_TYPE:-}" ]; then
  echo "$FAKE_BLKID_TYPE"
  exit 0
fi
exit "\${FAKE_BLKID_EXIT:-2}"
`,
	// The device-readability probe entrypoint.sh runs before it trusts a
	// blkid-exit-2 "nothing found" enough to format. Exits 0 (device reads
	// fine) unless `FAKE_DD_EXIT` says otherwise.
	dd: `#!/bin/sh
echo "dd $*" >> "$NAMZU_TEST_LOG"
exit "\${FAKE_DD_EXIT:-0}"
`,
	'mkfs.ext4': `#!/bin/sh
echo "mkfs.ext4 $*" >> "$NAMZU_TEST_LOG"
exit 0
`,
	mount: `#!/bin/sh
echo "mount $*" >> "$NAMZU_TEST_LOG"
exit 0
`,
	chown: `#!/bin/sh
echo "chown $*" >> "$NAMZU_TEST_LOG"
exit 0
`,
	// Real `mkdir`/`chmod`, delegated to by absolute path rather than left
	// to resolve through `basePath` like the other never-shimmed tools
	// (`[`, `printf`, ...): the HOME-resolution fallback's directory is
	// genuinely created and chmodded on THIS machine (see `runEntrypoint`'s
	// cleanup below), and a case proving `getent` is unreachable from
	// EVERY directory on PATH (`basePath: ''`) must still be able to reach
	// these two, or the fallback it is trying to observe could never
	// succeed either.
	mkdir: `#!/bin/sh
exec /bin/mkdir "$@"
`,
	chmod: `#!/bin/sh
exec /bin/chmod "$@"
`,
	// The HOME resolution's passwd lookup, in the same "print on success,
	// otherwise the not-found status" shape as the `blkid` fake above:
	// `FAKE_GETENT_HOME` unset means "no passwd entry for this uid" (exit
	// 2, matching real `getent`) — the default, so every EXISTING case
	// below that never mentions HOME still takes the fallback path without
	// this fake ever touching a real system directory like `/home/namzu`.
	// A case that wants the passwd path sets `FAKE_GETENT_HOME` to a
	// directory IT creates and owns (never a real absolute system path —
	// this script's own `mkdir`/`chown` are real, unshimmed operations
	// against this machine, exactly like the mount-branch's `chown` on
	// `$WORKSPACE_ROOT`).
	getent: `#!/bin/sh
echo "getent $*" >> "$NAMZU_TEST_LOG"
if [ -n "\${FAKE_GETENT_HOME:-}" ]; then
  echo "\${FAKE_GETENT_USER:-namzu}:x:$2:\${NAMZU_AGENT_GID:-1001}::\${FAKE_GETENT_HOME}:/bin/sh"
  exit 0
fi
exit 2
`,
	// The HOME resolution's ownership read-back, after its `chown` (faked
	// above, and always reporting success regardless of the real
	// filesystem). Reports the current `NAMZU_AGENT_UID` (default 1001)
	// for every queried path by default — the happy case where adoption
	// really did land — unless the path equals `FAKE_STAT_MISMATCH_PATH`,
	// in which case it reports a different uid: standing in for a real
	// `chown` that could not actually reassign a directory this uid does
	// not own (the permission boundary a non-root pod hits for real;
	// `chown`'s own fake cannot be made to fail selectively without
	// reintroducing that exact real permission check, which this file's
	// fakes exist to avoid needing).
	stat: `#!/bin/sh
echo "stat $*" >> "$NAMZU_TEST_LOG"
if [ -n "\${FAKE_STAT_MISMATCH_PATH:-}" ] && [ "$3" = "$FAKE_STAT_MISMATCH_PATH" ]; then
  echo "9999"
else
  echo "\${NAMZU_AGENT_UID:-1001}"
fi
`,
	// `setpriv`'s fake never actually execs its own argv (like real setpriv
	// would) — it only logs `$*` and exits, exactly as every other fake
	// here does. That is enough to verify the exec CHAIN entrypoint.sh
	// builds (setpriv's own flags, and that its final argument names
	// `tini` as the target with `node /opt/namzu/agent.cjs` as tini's own
	// argv) without needing a real `tini` binary or a second layer of
	// PATH-shimming to chase the exec through it. It also dumps the HOME
	// resolution's exports BEFORE logging its own invocation (never
	// after — several cases below rely on the setpriv line staying the
	// last one in the log): the only way to observe what a script that
	// never really execs was handed is to have it print its own
	// inherited environment.
	setpriv: `#!/bin/sh
echo "env HOME=$HOME USER=$USER LOGNAME=$LOGNAME XDG_CACHE_HOME=$XDG_CACHE_HOME XDG_CONFIG_HOME=$XDG_CONFIG_HOME" >> "$NAMZU_TEST_LOG"
echo "setpriv $*" >> "$NAMZU_TEST_LOG"
exit 0
`,
}

interface RunResult {
	readonly status: number | null
	readonly log: string[]
	/** The script's real stderr — distinct from `log`, which only ever holds
	 * what a fake tool chose to record. A missing/failing-tool abort writes
	 * its diagnostic here, never to the fake-tool log. */
	readonly stderr: string
}

interface RunOptions {
	/** Which fakes to install in the shim directory that goes in front of
	 * `basePath`. Defaults to every entry in `FAKE_TOOLS`; pass a subset (or
	 * omit a key) to prove a case where a tool is genuinely absent from
	 * every directory the script's PATH names, not merely made to fail. */
	fakes?: Record<string, string>
	/** The PATH segment appended after the shim directory. Defaults to the
	 * real `process.env.PATH`. Override it to prove "not found anywhere",
	 * since the default would otherwise let the test runner's OWN real
	 * `blkid` (etc.) answer once a fake is left out. */
	basePath?: string
}

/** `id`'s fake, layered on top of `FAKE_TOOLS` by cases that need a specific
 * uid: `FAKE_TOOLS.id` below defaults to reporting root, so every EXISTING
 * root-path case keeps taking the root branch it always has, whatever uid
 * the process actually running this test suite happens to be. */
function fakeId(uid: number): string {
	return `#!/bin/sh
echo "id $*" >> "$NAMZU_TEST_LOG"
echo "${uid}"
`
}

// Every directory a case creates directly — every `mktempWorkDir()` call
// (a case's own NAMZU_WORKSPACE_ROOT, a FAKE_GETENT_HOME target, ...) — is
// queued here by `mktempWorkDir` itself and swept in one `afterEach`, so
// nothing this file creates outlives the test that created it.
//
// `mkdir`/`chmod` genuinely delegate to this machine's real tools (only
// `chown`/`stat` are fully faked, above), so a run that takes the
// HOME-resolution fallback path really does create `/tmp/namzu-home-<uid>`
// on this machine — at whatever path entrypoint.sh's own
// `/tmp/namzu-home-$NAMZU_AGENT_UID` construction resolves to for the uid
// THIS call passed it, a path `mktempWorkDir` never sees — and entrypoint.sh
// does not clean up after itself. Every uid a case ran with (only when it
// actually supplied one; see `uniqueAgentUid` below) is queued in the
// second array below for the same sweep.
const tempDirsToClean: string[] = []
const fallbackHomesToClean: string[] = []

afterEach(() => {
	for (const dir of [...tempDirsToClean.splice(0), ...fallbackHomesToClean.splice(0)]) {
		rmSync(dir, { recursive: true, force: true })
	}
})

/**
 * entrypoint.sh's HOME resolution runs unconditionally, before the
 * root/non-root branch split (see its own "HOME for the guest agent"
 * comment) — so EVERY case below that gets past the `setpriv`-presence
 * check reaches it, whether or not the case cares about HOME at all. Its
 * fallback hardcodes `/tmp/namzu-home-$NAMZU_AGENT_UID`: production never
 * collides there (one pod, one mount namespace, one uid), but two
 * concurrent runs of THIS FILE (two vitest workers, two worktrees, two CI
 * matrix legs) that both left `NAMZU_AGENT_UID` unset — falling through to
 * entrypoint.sh's own default of 1001 — or that both happened to reuse the
 * same literal test value (this file itself used to reuse 1234/2001/3001/
 * 4001 across cases, safe within one process but not across two) raced on
 * that one shared path.
 *
 * The fix asks nothing of entrypoint.sh: it already reads
 * `NAMZU_AGENT_UID` to build that path, so every case below now passes an
 * id that is unique to this process AND this call instead of a fixed
 * literal or entrypoint.sh's own default — routing the SAME existing
 * override through a value nothing else on the machine can be using.
 * `mkdtempSync` is the stdlib's own answer to "a name nothing else on this
 * machine holds right now"; it is used here purely to source that
 * collision-free suffix (immediately removed — the directory this test
 * actually wants is the one entrypoint.sh itself creates at
 * `/tmp/namzu-home-<suffix>`, not the mkdtemp path).
 *
 * Nothing downstream needs this value to look like a real uid: `chown`,
 * `stat` and `id` are all faked in this file (see `FAKE_TOOLS` above), so
 * neither entrypoint.sh nor its faked tools ever validate it as numeric.
 */
function uniqueAgentUid(): string {
	const probe = mkdtempSync(join(tmpdir(), 'namzu-agentuid-'))
	rmSync(probe, { recursive: true, force: true })
	return basename(probe).slice('namzu-agentuid-'.length)
}

function runEntrypoint(env: Record<string, string | undefined>, options: RunOptions = {}): RunResult {
	const { fakes = FAKE_TOOLS, basePath = process.env.PATH ?? '' } = options
	const workDir = mktempWorkDir()
	// Only queued when this call actually set one: a case that leaves
	// NAMZU_AGENT_UID unset either never reaches the fallback (its passwd
	// path resolves) or — nothing in this file does this any more — would
	// fall through to entrypoint.sh's own shared default, which must never
	// be swept here (another concurrent process may legitimately own it).
	if (env.NAMZU_AGENT_UID !== undefined) {
		fallbackHomesToClean.push(`/tmp/namzu-home-${env.NAMZU_AGENT_UID}`)
	}
	try {
		const binDir = join(workDir, 'bin')
		mkdirSync(binDir)
		for (const [name, script] of Object.entries(fakes)) {
			const toolPath = join(binDir, name)
			writeFileSync(toolPath, script)
			chmodSync(toolPath, 0o755)
		}
		const logPath = join(workDir, 'log.txt')
		writeFileSync(logPath, '')

		const result = spawnSync(SH_BIN, [ENTRYPOINT_PATH], {
			env: {
				// The shim directory resolves first; `basePath` (real PATH by
				// default) supplies `mkdir`, `[`, `printf` etc. — never
				// shimmed, never meant to be — so they keep working exactly
				// as they do outside a test, unless a case deliberately
				// narrows `basePath` to prove a tool is unreachable.
				PATH: `${binDir}:${basePath}`,
				NAMZU_TEST_LOG: logPath,
				...env,
			},
			encoding: 'utf8',
		})
		const log = readFileSync(logPath, 'utf8')
			.split('\n')
			.filter((line) => line.length > 0)
		return { status: result.status, log, stderr: result.stderr ?? '' }
	} finally {
		rmSync(workDir, { recursive: true, force: true })
	}
}

function mktempWorkDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'k8s-entrypoint-'))
	tempDirsToClean.push(dir)
	return dir
}

/** The `env HOME=... USER=... ...` line `setpriv`'s fake dumps, parsed into
 * a plain object — `undefined` if the run never reached (a fake) `setpriv`
 * at all (an early refusal, e.g.). */
function exportedEnv(result: RunResult): Record<string, string> | undefined {
	const line = result.log.find((entry) => entry.startsWith('env '))
	if (line === undefined) return undefined
	const values: Record<string, string> = {}
	for (const pair of line.slice('env '.length).split(' ')) {
		const eq = pair.indexOf('=')
		if (eq < 0) continue
		values[pair.slice(0, eq)] = pair.slice(eq + 1)
	}
	return values
}

describe('entrypoint.sh parses as POSIX sh', () => {
	it('parses under sh -n', () => {
		expect(() => execFileSync('sh', ['-n', ENTRYPOINT_PATH])).not.toThrow()
	})

	it('parses under dash -n, when dash is installed', () => {
		if (!hasCommand('dash')) {
			console.warn('dash not found on this machine — skipping (CI installs it; see install.sh\'s own gate)')
			return
		}
		expect(() => execFileSync('dash', ['-n', ENTRYPOINT_PATH])).not.toThrow()
	})
})

describe('entrypoint.sh always execs into setpriv last', () => {
	it("the script's final command is an `exec`, scanned as text", () => {
		const lines = ENTRYPOINT_SOURCE.trimEnd().split('\n')
		// The exec spans several lines (one flag per line, `\`-continued);
		// walk back from the end past blank/comment lines to the first
		// non-continuation line and assert THAT starts the exec.
		let i = lines.length - 1
		while (i >= 0 && /^\s*(#.*)?$/.test(lines[i] as string)) i--
		while (i > 0 && /\\\s*$/.test(lines[i - 1] as string)) i--
		expect(lines[i]).toMatch(/^exec\s+setpriv\b/)
	})

	it('the setpriv invocation carries every hardening flag the privilege probe checks for', () => {
		const uid = uniqueAgentUid()
		const result = runEntrypoint({
			NAMZU_AGENT_UID: uid,
			NAMZU_AGENT_GID: uid,
			NAMZU_WORKSPACE_ROOT: mktempWorkDir(),
		})
		const setprivLine = result.log.find((line) => line.startsWith('setpriv '))
		expect(setprivLine).toBeDefined()
		expect(setprivLine).toContain(`--reuid=${uid}`)
		expect(setprivLine).toContain(`--regid=${uid}`)
		expect(setprivLine).toContain('--clear-groups')
		expect(setprivLine).toContain('--inh-caps=-all')
		expect(setprivLine).toContain('--bounding-set=-all')
		expect(setprivLine).toContain('--no-new-privs')
		// The exec chain's tail: setpriv's own final argument names `tini` as
		// pid 1 (the subreaper — see the Dockerfile and entrypoint.sh's own
		// comments on why), which in turn execs the agent as its child, so
		// the two flags below must appear in this order in the SAME line.
		expect(setprivLine).toContain('-- /usr/bin/tini -- node /opt/namzu/agent.cjs')
		// And it really is the LAST thing this run did.
		expect(result.log.at(-1)).toBe(setprivLine)
	})
})

describe('no device configured (a task pod)', () => {
	it('skips blkid/mkfs/mount/workspace-chown entirely and still execs setpriv', () => {
		const root = mktempWorkDir()
		const result = runEntrypoint({
			NAMZU_WORKSPACE_ROOT: root,
			NAMZU_AGENT_UID: uniqueAgentUid(),
			// Explicitly absent/empty — the task-pod case.
			NAMZU_WORKSPACE_DEVICE: '',
		})
		expect(result.status).toBe(0)
		expect(result.log.some((line) => line.startsWith('blkid '))).toBe(false)
		expect(result.log.some((line) => line.startsWith('mkfs.ext4 '))).toBe(false)
		expect(result.log.some((line) => line.startsWith('mount '))).toBe(false)
		// No device to mount, so no chown of $WORKSPACE_ROOT — but HOME
		// resolution's own chown (of its fallback home) still runs
		// unconditionally; see "HOME for the guest agent" below.
		expect(result.log.some((line) => line.startsWith('chown ') && line.includes(root))).toBe(false)
		expect(result.log.some((line) => line.startsWith('setpriv '))).toBe(true)
	})
})

describe('running as a non-root uid (sandboxtemplate-task.yaml\'s pod)', () => {
	it('skips blkid/mkfs/mount/workspace-chown and execs setpriv with only --no-new-privs, never the root-path flags', () => {
		const root = mktempWorkDir()
		const result = runEntrypoint(
			{
				NAMZU_WORKSPACE_ROOT: root,
				NAMZU_WORKSPACE_DEVICE: '',
				NAMZU_AGENT_UID: uniqueAgentUid(),
			},
			{ fakes: { ...FAKE_TOOLS, id: fakeId(1001) } },
		)
		expect(result.status).toBe(0)
		expect(result.log.some((line) => line.startsWith('blkid '))).toBe(false)
		expect(result.log.some((line) => line.startsWith('mkfs.ext4 '))).toBe(false)
		expect(result.log.some((line) => line.startsWith('mount '))).toBe(false)
		// No device to mount, so no chown of $WORKSPACE_ROOT — but HOME
		// resolution's own chown (of its fallback home) still runs
		// unconditionally; see "HOME for the guest agent" below.
		expect(result.log.some((line) => line.startsWith('chown ') && line.includes(root))).toBe(false)

		const setprivLine = result.log.find((line) => line.startsWith('setpriv '))
		expect(setprivLine).toBeDefined()
		expect(setprivLine).toContain('--no-new-privs')
		expect(setprivLine).toContain('-- /usr/bin/tini -- node /opt/namzu/agent.cjs')
		// None of the root-path privilege-drop flags: this process has none
		// of the capabilities they need (CAP_SETUID/CAP_SETGID/CAP_SETPCAP),
		// and the pod's own securityContext already dropped everything they
		// would have dropped.
		expect(setprivLine).not.toContain('--reuid')
		expect(setprivLine).not.toContain('--regid')
		expect(setprivLine).not.toContain('--clear-groups')
		expect(setprivLine).not.toContain('--inh-caps')
		expect(setprivLine).not.toContain('--bounding-set')
		// And it really is the last thing this run did.
		expect(result.log.at(-1)).toBe(setprivLine)
	})

	it('exits non-zero, before touching blkid/mkfs/mount, when a device is set but the container is not root', () => {
		const root = mktempWorkDir()
		const result = runEntrypoint(
			{
				NAMZU_WORKSPACE_ROOT: root,
				// A workspace pod's device, on a pod shaped like a task pod —
				// the misconfiguration this branch exists to refuse rather
				// than silently skip.
				NAMZU_WORKSPACE_DEVICE: '/dev/namzu-workspace',
				NAMZU_AGENT_UID: uniqueAgentUid(),
			},
			{ fakes: { ...FAKE_TOOLS, id: fakeId(1001) } },
		)
		expect(result.status).not.toBe(0)
		expect(result.log.some((line) => line.startsWith('blkid '))).toBe(false)
		expect(result.log.some((line) => line.startsWith('mkfs.ext4 '))).toBe(false)
		expect(result.log.some((line) => line.startsWith('mount '))).toBe(false)
		expect(result.log.some((line) => line.startsWith('setpriv '))).toBe(false)
		expect(result.stderr).toContain('NAMZU_WORKSPACE_DEVICE')
		expect(result.stderr).toContain('1001')
	})
})

describe.skipIf(LOOP_DEVICE === undefined)('a workspace device is configured', () => {
	it('formats an unformatted device (blkid reports nothing) before mounting it', () => {
		const root = mktempWorkDir()
		const uid = uniqueAgentUid()
		const result = runEntrypoint({
			NAMZU_WORKSPACE_DEVICE: LOOP_DEVICE,
			NAMZU_WORKSPACE_ROOT: root,
			NAMZU_AGENT_UID: uid,
			NAMZU_AGENT_GID: uid,
			// No FAKE_BLKID_TYPE: the fake exits 2 and prints nothing, exactly
			// like real blkid against a device with no recognized filesystem.
		})
		expect(result.status).toBe(0)

		const blkidLine = result.log.find((l) => l.startsWith('blkid '))
		const mkfsLine = result.log.find((l) => l.startsWith('mkfs.ext4 '))
		const mountLine = result.log.find((l) => l.startsWith('mount '))
		// `.find`, not `.some` — HOME resolution's own fallback also chowns
		// (to the same `<uid>:<uid>`, but a different, non-workspace path),
		// so the WORKSPACE chown is picked out by the directory it targets.
		const chownLine = result.log.find((l) => l.startsWith('chown ') && l.includes(root))

		expect(blkidLine).toContain(LOOP_DEVICE as string)
		expect(mkfsLine).toBeDefined()
		expect(mkfsLine).toContain('-F')
		expect(mkfsLine).toContain(LOOP_DEVICE as string)
		expect(mountLine).toContain('noatime')
		expect(mountLine).toContain('nodev')
		expect(mountLine).toContain('nosuid')
		expect(mountLine).toContain(LOOP_DEVICE as string)
		expect(mountLine).toContain(root)
		expect(chownLine).toContain(`${uid}:${uid}`)
		expect(chownLine).toContain(root)

		// Order matters: mkfs only after blkid answers, mount only after
		// mkfs, the WORKSPACE chown only after mount, setpriv last of all.
		// (HOME resolution's own chown — a different call, against a
		// different path — runs earlier still; see "HOME for the guest
		// agent" below for its own ordering guarantees.)
		const indices = [blkidLine, mkfsLine, mountLine, chownLine].map((line) =>
			line === undefined ? -1 : result.log.indexOf(line),
		)
		const setprivIndex = result.log.findIndex((line) => line.startsWith('setpriv '))
		indices.push(setprivIndex)
		expect(indices).toEqual([...indices].sort((a, b) => a - b))
		expect(indices.every((index) => index !== -1)).toBe(true)
	})

	it('THE DATA-DESTRUCTION REGRESSION TEST: an already-formatted device is mounted WITHOUT calling mkfs', () => {
		const root = mktempWorkDir()
		const result = runEntrypoint({
			NAMZU_WORKSPACE_DEVICE: LOOP_DEVICE,
			NAMZU_WORKSPACE_ROOT: root,
			NAMZU_AGENT_UID: uniqueAgentUid(),
			FAKE_BLKID_TYPE: 'ext4',
		})
		expect(result.status).toBe(0)

		expect(result.log.some((line) => line.startsWith('mkfs.ext4 '))).toBe(false)
		const mountLine = result.log.find((line) => line.startsWith('mount '))
		expect(mountLine).toContain(LOOP_DEVICE as string)
		expect(mountLine).toContain(root)
		expect(result.log.some((line) => line.startsWith('setpriv '))).toBe(true)
	})

	for (const exitCode of [127, 126, 4, 8]) {
		it(`a blkid that exits ${exitCode} with no output aborts before mkfs or mount, naming the status`, () => {
			const root = mktempWorkDir()
			const result = runEntrypoint({
				NAMZU_WORKSPACE_DEVICE: LOOP_DEVICE,
				NAMZU_WORKSPACE_ROOT: root,
				NAMZU_AGENT_UID: uniqueAgentUid(),
				FAKE_BLKID_EXIT: String(exitCode),
			})
			expect(result.status).not.toBe(0)
			expect(result.log.some((line) => line.startsWith('mkfs.ext4 '))).toBe(false)
			expect(result.log.some((line) => line.startsWith('mount '))).toBe(false)
			expect(result.stderr).toContain(String(exitCode))
		})
	}

	it('a blkid missing from PATH entirely aborts before mkfs or mount and names blkid in the log', () => {
		const root = mktempWorkDir()
		const { blkid: _blkidFake, ...fakesWithoutBlkid } = FAKE_TOOLS
		const result = runEntrypoint(
			{
				NAMZU_WORKSPACE_DEVICE: LOOP_DEVICE,
				NAMZU_WORKSPACE_ROOT: root,
				NAMZU_AGENT_UID: uniqueAgentUid(),
			},
			{
				fakes: fakesWithoutBlkid,
				// Deliberately not the real PATH: the shim directory this run
				// gets (every fake except blkid) is ALL that is searched, so
				// this proves blkid is unreachable, not merely that the
				// fake was made to fail — and it can't quietly pass by
				// falling back to whatever real blkid the machine running
				// this test happens to have.
				basePath: '',
			},
		)
		expect(result.status).not.toBe(0)
		expect(result.log.some((line) => line.startsWith('mkfs.ext4 '))).toBe(false)
		expect(result.log.some((line) => line.startsWith('mount '))).toBe(false)
		expect(result.stderr).toContain('blkid')
	})

	it('blkid exits 2 but the device cannot be read: aborts before mkfs, without trusting "empty"', () => {
		const root = mktempWorkDir()
		const result = runEntrypoint({
			NAMZU_WORKSPACE_DEVICE: LOOP_DEVICE,
			NAMZU_WORKSPACE_ROOT: root,
			NAMZU_AGENT_UID: uniqueAgentUid(),
			// FAKE_BLKID_EXIT unset: the fake's default (2, "nothing found").
			FAKE_DD_EXIT: '1',
		})
		expect(result.status).not.toBe(0)
		expect(result.log.some((line) => line.startsWith('dd '))).toBe(true)
		expect(result.log.some((line) => line.startsWith('mkfs.ext4 '))).toBe(false)
		expect(result.log.some((line) => line.startsWith('mount '))).toBe(false)
	})

	it('does nothing device-related when NAMZU_WORKSPACE_DEVICE names a path that is not a block device', () => {
		const root = mktempWorkDir()
		const notADevice = join(root, 'not-a-device')
		writeFileSync(notADevice, 'plain file')
		const result = runEntrypoint({
			NAMZU_WORKSPACE_DEVICE: notADevice,
			NAMZU_WORKSPACE_ROOT: root,
			NAMZU_AGENT_UID: uniqueAgentUid(),
		})
		expect(result.status).toBe(0)
		expect(result.log.some((line) => line.startsWith('blkid '))).toBe(false)
		expect(result.log.some((line) => line.startsWith('mkfs.ext4 '))).toBe(false)
		expect(result.log.some((line) => line.startsWith('mount '))).toBe(false)
		expect(result.log.some((line) => line.startsWith('setpriv '))).toBe(true)
	})
})

describe('NAMZU_SANDBOX_WORKSPACE follows NAMZU_WORKSPACE_ROOT', () => {
	it('exports NAMZU_SANDBOX_WORKSPACE=$NAMZU_WORKSPACE_ROOT for the exec\'d agent', () => {
		// setpriv's fake does not itself exec node, so this asserts on the
		// SOURCE rather than on an env dump — the fake process never gets a
		// chance to print its own environment before this script's own
		// `export` line has already run (it runs before the exec either way).
		expect(ENTRYPOINT_SOURCE).toMatch(/export NAMZU_SANDBOX_WORKSPACE="\$WORKSPACE_ROOT"/)
	})
})

describe('HOME for the guest agent and its children', () => {
	it('getent unreachable on PATH at all: the fallback home is exported and really created', () => {
		const { getent: _getentFake, ...fakesWithoutGetent } = FAKE_TOOLS
		const uid = uniqueAgentUid()
		const result = runEntrypoint(
			{ NAMZU_WORKSPACE_ROOT: mktempWorkDir(), NAMZU_WORKSPACE_DEVICE: '', NAMZU_AGENT_UID: uid },
			// `basePath: ''`, exactly like the "blkid missing from PATH
			// entirely" case above: this shim directory (every fake except
			// getent) is ALL that is searched, so this proves getent is
			// unreachable, not merely made to fail. `mkdir`/`chmod` above
			// delegate to this machine's real tools by absolute path, so the
			// fallback they need can still run.
			{ fakes: fakesWithoutGetent, basePath: '' },
		)
		expect(result.status).toBe(0)
		expect(exportedEnv(result)?.HOME).toBe(`/tmp/namzu-home-${uid}`)
		expect(existsSync(`/tmp/namzu-home-${uid}`)).toBe(true)
	})

	it('getent naming a directory that does not exist yet: created, chowned and adopted as HOME', () => {
		const resolved = join(mktempWorkDir(), 'resolved-home')
		const result = runEntrypoint({
			NAMZU_WORKSPACE_ROOT: mktempWorkDir(),
			NAMZU_WORKSPACE_DEVICE: '',
			FAKE_GETENT_HOME: resolved,
		})
		expect(result.status).toBe(0)
		expect(existsSync(resolved)).toBe(true)
		expect(
			result.log.some((line) => line.startsWith('chown ') && line.includes(resolved)),
		).toBe(true)
		expect(exportedEnv(result)?.HOME).toBe(resolved)
	})

	it('getent naming a directory this uid cannot be made to own: falls back, never exports the unwritable path', () => {
		const unusable = join(mktempWorkDir(), 'someone-elses-home')
		mkdirSync(unusable)
		const uid = uniqueAgentUid()
		const result = runEntrypoint({
			NAMZU_WORKSPACE_ROOT: mktempWorkDir(),
			NAMZU_WORKSPACE_DEVICE: '',
			NAMZU_AGENT_UID: uid,
			FAKE_GETENT_HOME: unusable,
			// The real chown here is faked to always "succeed" (like every
			// other fake in this file) — this is what actually stands in for
			// a real chown that could not reassign a directory the agent uid
			// does not own: the readback afterward says it is still not
			// theirs.
			FAKE_STAT_MISMATCH_PATH: unusable,
		})
		expect(result.status).toBe(0)
		const home = exportedEnv(result)?.HOME
		expect(home).toBe(`/tmp/namzu-home-${uid}`)
		expect(home).not.toBe(unusable)
	})

	it('never resolves a HOME under $WORKSPACE_ROOT, even when getent names one there', () => {
		const root = mktempWorkDir()
		const insideWorkspace = join(root, 'fake-home')
		const uid = uniqueAgentUid()
		const result = runEntrypoint({
			NAMZU_WORKSPACE_ROOT: root,
			NAMZU_WORKSPACE_DEVICE: '',
			NAMZU_AGENT_UID: uid,
			FAKE_GETENT_HOME: insideWorkspace,
		})
		expect(result.status).toBe(0)
		const home = exportedEnv(result)?.HOME
		expect(home).toBeDefined()
		expect((home as string).startsWith(root)).toBe(false)
		expect(home).toBe(`/tmp/namzu-home-${uid}`)
	})

	it('resolves to the SAME HOME on the non-root branch as on the root branch, given the same inputs', () => {
		const uid = uniqueAgentUid()
		const rootRun = runEntrypoint({
			NAMZU_WORKSPACE_ROOT: mktempWorkDir(),
			NAMZU_WORKSPACE_DEVICE: '',
			NAMZU_AGENT_UID: uid,
			NAMZU_AGENT_GID: uid,
		})
		const nonRootRun = runEntrypoint(
			{
				NAMZU_WORKSPACE_ROOT: mktempWorkDir(),
				NAMZU_WORKSPACE_DEVICE: '',
				NAMZU_AGENT_UID: uid,
				NAMZU_AGENT_GID: uid,
			},
			{ fakes: { ...FAKE_TOOLS, id: fakeId(3001) } },
		)
		expect(rootRun.status).toBe(0)
		expect(nonRootRun.status).toBe(0)
		expect(exportedEnv(nonRootRun)?.HOME).toBe(`/tmp/namzu-home-${uid}`)
		expect(exportedEnv(nonRootRun)?.HOME).toBe(exportedEnv(rootRun)?.HOME)

		const setprivLine = nonRootRun.log.find((line) => line.startsWith('setpriv '))
		expect(setprivLine).toContain('--no-new-privs')
		expect(setprivLine).not.toContain('--reuid')
	})

	it('the root branch exports HOME (and USER/LOGNAME/XDG_*) before its multi-flag setpriv', () => {
		const uid = uniqueAgentUid()
		const result = runEntrypoint({
			NAMZU_WORKSPACE_ROOT: mktempWorkDir(),
			NAMZU_WORKSPACE_DEVICE: '',
			NAMZU_AGENT_UID: uid,
			NAMZU_AGENT_GID: uid,
		})
		expect(result.status).toBe(0)
		// The only way a fake that never really execs can show what it was
		// handed: the value is already exported by the time setpriv's own
		// (fake) invocation dumps it, which is only possible if the export
		// ran before the exec — exactly the ordering this test is for.
		const env = exportedEnv(result)
		expect(env?.HOME).toBe(`/tmp/namzu-home-${uid}`)
		expect(env?.USER).toBe('namzu')
		expect(env?.LOGNAME).toBe('namzu')
		expect(env?.XDG_CACHE_HOME).toBe(`/tmp/namzu-home-${uid}/.cache`)
		expect(env?.XDG_CONFIG_HOME).toBe(`/tmp/namzu-home-${uid}/.config`)

		const setprivLine = result.log.find((line) => line.startsWith('setpriv '))
		expect(setprivLine).toContain(`--reuid=${uid}`)
		expect(setprivLine).toContain(`--regid=${uid}`)
	})

	it('a resolvable passwd home exports USER/LOGNAME from the passwd entry, not the fallback default', () => {
		const resolved = join(mktempWorkDir(), 'resolved-home')
		const result = runEntrypoint({
			NAMZU_WORKSPACE_ROOT: mktempWorkDir(),
			NAMZU_WORKSPACE_DEVICE: '',
			FAKE_GETENT_HOME: resolved,
			FAKE_GETENT_USER: 'custom-agent',
		})
		expect(result.status).toBe(0)
		const env = exportedEnv(result)
		expect(env?.HOME).toBe(resolved)
		expect(env?.USER).toBe('custom-agent')
		expect(env?.LOGNAME).toBe('custom-agent')
	})
})

if (LOOP_DEVICE === undefined) {
	console.warn(
		'no /dev/loop0..7 found as a block device on this machine — the ' +
			'workspace-device cases in entrypoint.test.ts were skipped rather ' +
			'than failed. This repo\'s own Linux CI runner has these.',
	)
}
