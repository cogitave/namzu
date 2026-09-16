/**
 * `../entrypoint.sh`: POSIX-sh parse checks, plus its actual mount/format/
 * drop-privilege LOGIC exercised with PATH-shimmed `blkid`, `mkfs.ext4`,
 * `mount`, `chown` and `setpriv` — never the real tools, so this suite
 * needs no root and is safe in the default `pnpm test` tier the rest of
 * this package's suites already run in.
 *
 * The one case this file exists for above all others: a device that
 * ALREADY carries a filesystem must be mounted WITHOUT calling `mkfs` —
 * see entrypoint.sh's own header comment for why an unconditional `mkfs`
 * there would be the single most destructive possible bug in this whole
 * backend (it would erase a resumed workspace's disk on every boot).
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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRYPOINT_PATH = join(HERE, '../entrypoint.sh')
const ENTRYPOINT_SOURCE = readFileSync(ENTRYPOINT_PATH, 'utf8')

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
	blkid: `#!/bin/sh
echo "blkid $*" >> "$NAMZU_TEST_LOG"
if [ -n "\${FAKE_BLKID_TYPE:-}" ]; then
  echo "$FAKE_BLKID_TYPE"
  exit 0
fi
exit 2
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
	// `setpriv`'s fake never actually execs its own argv (like real setpriv
	// would) — it only logs `$*` and exits, exactly as every other fake
	// here does. That is enough to verify the exec CHAIN entrypoint.sh
	// builds (setpriv's own flags, and that its final argument names
	// `tini` as the target with `node /opt/namzu/agent.cjs` as tini's own
	// argv) without needing a real `tini` binary or a second layer of
	// PATH-shimming to chase the exec through it.
	setpriv: `#!/bin/sh
echo "setpriv $*" >> "$NAMZU_TEST_LOG"
exit 0
`,
}

interface RunResult {
	readonly status: number | null
	readonly log: string[]
}

function runEntrypoint(env: Record<string, string | undefined>): RunResult {
	const workDir = mktempWorkDir()
	try {
		const binDir = join(workDir, 'bin')
		mkdirSync(binDir)
		for (const [name, script] of Object.entries(FAKE_TOOLS)) {
			const toolPath = join(binDir, name)
			writeFileSync(toolPath, script)
			chmodSync(toolPath, 0o755)
		}
		const logPath = join(workDir, 'log.txt')
		writeFileSync(logPath, '')

		const result = spawnSync('sh', [ENTRYPOINT_PATH], {
			env: {
				// Fakes resolve first; the rest of PATH stays real so `mkdir`,
				// `[`, `printf` etc. — never shimmed, never meant to be — keep
				// working exactly as they do outside a test.
				PATH: `${binDir}:${process.env.PATH ?? ''}`,
				NAMZU_TEST_LOG: logPath,
				...env,
			},
			encoding: 'utf8',
		})
		const log = readFileSync(logPath, 'utf8')
			.split('\n')
			.filter((line) => line.length > 0)
		return { status: result.status, log }
	} finally {
		rmSync(workDir, { recursive: true, force: true })
	}
}

function mktempWorkDir(): string {
	return mkdtempSync(join(tmpdir(), 'k8s-entrypoint-'))
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
		const result = runEntrypoint({
			NAMZU_AGENT_UID: '1234',
			NAMZU_AGENT_GID: '1234',
			NAMZU_WORKSPACE_ROOT: mktempWorkDir(),
		})
		const setprivLine = result.log.find((line) => line.startsWith('setpriv '))
		expect(setprivLine).toBeDefined()
		expect(setprivLine).toContain('--reuid=1234')
		expect(setprivLine).toContain('--regid=1234')
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
	it('skips blkid/mkfs/mount/chown entirely and still execs setpriv', () => {
		const result = runEntrypoint({
			NAMZU_WORKSPACE_ROOT: mktempWorkDir(),
			// Explicitly absent/empty — the task-pod case.
			NAMZU_WORKSPACE_DEVICE: '',
		})
		expect(result.status).toBe(0)
		expect(result.log.some((line) => line.startsWith('blkid '))).toBe(false)
		expect(result.log.some((line) => line.startsWith('mkfs.ext4 '))).toBe(false)
		expect(result.log.some((line) => line.startsWith('mount '))).toBe(false)
		expect(result.log.some((line) => line.startsWith('chown '))).toBe(false)
		expect(result.log.some((line) => line.startsWith('setpriv '))).toBe(true)
	})
})

describe.skipIf(LOOP_DEVICE === undefined)('a workspace device is configured', () => {
	it('formats an unformatted device (blkid reports nothing) before mounting it', () => {
		const root = mktempWorkDir()
		const result = runEntrypoint({
			NAMZU_WORKSPACE_DEVICE: LOOP_DEVICE,
			NAMZU_WORKSPACE_ROOT: root,
			NAMZU_AGENT_UID: '2001',
			NAMZU_AGENT_GID: '2001',
			// No FAKE_BLKID_TYPE: the fake exits 2 and prints nothing, exactly
			// like real blkid against a device with no recognized filesystem.
		})
		expect(result.status).toBe(0)

		const blkidLine = result.log.find((l) => l.startsWith('blkid '))
		const mkfsLine = result.log.find((l) => l.startsWith('mkfs.ext4 '))
		const mountLine = result.log.find((l) => l.startsWith('mount '))
		const chownLine = result.log.find((l) => l.startsWith('chown '))

		expect(blkidLine).toContain(LOOP_DEVICE as string)
		expect(mkfsLine).toBeDefined()
		expect(mkfsLine).toContain('-F')
		expect(mkfsLine).toContain(LOOP_DEVICE as string)
		expect(mountLine).toContain('noatime')
		expect(mountLine).toContain('nodev')
		expect(mountLine).toContain('nosuid')
		expect(mountLine).toContain(LOOP_DEVICE as string)
		expect(mountLine).toContain(root)
		expect(chownLine).toContain('2001:2001')
		expect(chownLine).toContain(root)

		// Order matters: mkfs only after blkid answers, mount only after
		// mkfs, chown only after mount, setpriv last of all.
		const order = result.log.map((line) => line.split(' ')[0])
		const indices = ['blkid', 'mkfs.ext4', 'mount', 'chown', 'setpriv'].map((tool) =>
			order.indexOf(tool),
		)
		expect(indices).toEqual([...indices].sort((a, b) => a - b))
		expect(indices.every((index) => index !== -1)).toBe(true)
	})

	it('THE DATA-DESTRUCTION REGRESSION TEST: an already-formatted device is mounted WITHOUT calling mkfs', () => {
		const root = mktempWorkDir()
		const result = runEntrypoint({
			NAMZU_WORKSPACE_DEVICE: LOOP_DEVICE,
			NAMZU_WORKSPACE_ROOT: root,
			FAKE_BLKID_TYPE: 'ext4',
		})
		expect(result.status).toBe(0)

		expect(result.log.some((line) => line.startsWith('mkfs.ext4 '))).toBe(false)
		const mountLine = result.log.find((line) => line.startsWith('mount '))
		expect(mountLine).toContain(LOOP_DEVICE as string)
		expect(mountLine).toContain(root)
		expect(result.log.some((line) => line.startsWith('setpriv '))).toBe(true)
	})

	it('does nothing device-related when NAMZU_WORKSPACE_DEVICE names a path that is not a block device', () => {
		const root = mktempWorkDir()
		const notADevice = join(root, 'not-a-device')
		writeFileSync(notADevice, 'plain file')
		const result = runEntrypoint({
			NAMZU_WORKSPACE_DEVICE: notADevice,
			NAMZU_WORKSPACE_ROOT: root,
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

if (LOOP_DEVICE === undefined) {
	console.warn(
		'no /dev/loop0..7 found as a block device on this machine — the ' +
			'workspace-device cases in entrypoint.test.ts were skipped rather ' +
			'than failed. This repo\'s own Linux CI runner has these.',
	)
}
