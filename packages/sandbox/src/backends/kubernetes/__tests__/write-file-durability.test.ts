/**
 * What a `write-file` reply of `ok` means, against the REAL guest agent.
 *
 * It used to mean "`fs.writeFile` returned", which is "the bytes are in the
 * page cache" — and for as long as nothing took a guest away deliberately,
 * nothing could tell the difference. A workspace exists to be suspended and
 * resumed, and `suspend()` stops the pod within a second or two of this
 * reply, so the difference became the quietest kind of data loss: nothing
 * fails, and the file is simply older than the caller was told. The same
 * write also truncated the target in place, so a stop halfway through left
 * a file that was neither the old one nor the new one.
 *
 * So the reply now means the bytes are on the device, by the standard
 * sequence: temp sibling, `fsync` the file, `rename` onto the target,
 * `fsync` the directory. Three of those four steps are observable from
 * outside — the file that appears, the temp file that does not survive, the
 * target that is untouched when the write fails. The `fsync`s are not, so
 * this file observes them the only way a test in this process can: by
 * replacing `fs.open` before the agent is loaded and recording what the
 * handles it hands back are asked to do. That is a white-box assertion on
 * purpose; the alternative is a suite that cannot tell a durable write from
 * the one this replaces.
 *
 * What NO test here can prove is that the device wrote what the kernel
 * handed it. `fsync` returning is the strongest promise available from
 * userspace, and on a VM runtime what happens to the guest's page cache
 * during teardown is the runtime's business — which is exactly why the
 * acceptance criterion for that lives on a cluster (`k8s/scripts/
 * suspend-resume.mjs`) and not here.
 */

import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import fsPromises from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { AddressInfo, Server } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AGENT_ENV_KEYS } from './fixtures/agent-env.js'
import { sendFramedRequest } from './fixtures/framed-agent-client.js'

const IS_WINDOWS = process.platform === 'win32'
const IS_ROOT = process.getuid?.() === 0
const require_ = createRequire(import.meta.url)
const AGENT_PATH = '../../../../agent/agent.cjs'
const POD_UID = '2b9d0c71-6a3e-4f52-9b0a-5d8e1f2c3a44'

interface AgentModule {
	startListening(): Promise<Server>
}

/** One `fsync` the agent asked for, and what it had opened to ask. */
interface RecordedSync {
	readonly path: string
	readonly flags: string
}

let workDir: string
let listener: Server | undefined
let saved: Record<string, string | undefined>
let syncs: RecordedSync[]
let restoreOpen: (() => void) | undefined

function clearEnv(keys: readonly string[]): void {
	for (const key of keys) delete process.env[key]
}

/**
 * Replace `fs.open` with one that records every `sync()` its handles are
 * asked for. Installed BEFORE the agent module is loaded, on the module
 * object the agent's own `require('node:fs/promises')` resolves to — the
 * agent looks the property up at call time, so one patched property is
 * enough and nothing about the agent has to know.
 */
function recordSyncs(): void {
	const realOpen = fsPromises.open
	const patched = async (...args: Parameters<typeof fsPromises.open>) => {
		const handle = await realOpen(...args)
		const path = String(args[0])
		const flags = String(args[1] ?? 'r')
		const realSync = handle.sync.bind(handle)
		handle.sync = async () => {
			syncs.push({ path, flags })
			await realSync()
		}
		return handle
	}
	;(fsPromises as { open: typeof fsPromises.open }).open = patched as typeof fsPromises.open
	restoreOpen = () => {
		;(fsPromises as { open: typeof fsPromises.open }).open = realOpen
	}
}

async function startAgent(): Promise<number> {
	process.env.NAMZU_AGENT_TCP_PORT = '0'
	process.env.NAMZU_AGENT_BIND_TOKEN = POD_UID
	delete require_.cache[require_.resolve(AGENT_PATH)]
	const agent = require_(AGENT_PATH) as AgentModule
	listener = await agent.startListening()
	return (listener.address() as AddressInfo).port
}

async function ask(port: number, op: string, body: unknown): Promise<Record<string, unknown>> {
	const exchange = await sendFramedRequest(port, { op, token: POD_UID, body })
	return exchange.reply
}

/** Every part file left behind under the workspace, at any depth. */
function strayPartFiles(dir: string = workDir): string[] {
	const out: string[] = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) out.push(...strayPartFiles(full))
		else if (entry.name.startsWith('.namzu-write-')) out.push(full)
	}
	return out
}

beforeEach(() => {
	saved = Object.fromEntries(AGENT_ENV_KEYS.map((key) => [key, process.env[key]]))
	clearEnv(AGENT_ENV_KEYS)
	syncs = []
	workDir = realpathSync(mkdtempSync(join(tmpdir(), 'k8s-write-durable-')))
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
	recordSyncs()
})

afterEach(async () => {
	restoreOpen?.()
	restoreOpen = undefined
	if (listener) {
		await new Promise<void>((resolve) => listener?.close(() => resolve()))
		listener = undefined
	}
	clearEnv(AGENT_ENV_KEYS)
	for (const [key, value] of Object.entries(saved)) {
		if (value !== undefined) process.env[key] = value
	}
	rmSync(workDir, { recursive: true, force: true })
})

describe.skipIf(IS_WINDOWS)('a whole-body write, made durable', () => {
	it('fsyncs the file and then the directory before it answers ok', async () => {
		const port = await startAgent()
		const reply = await ask(port, 'write-file', { path: 'notes.txt', content: 'durable' })

		// `guestBootId` rides along on every authenticated reply; asserting
		// the whole object rather than a subset is what would catch the
		// durable path quietly dropping `bytesWritten`.
		expect(reply).toEqual({ ok: true, guestBootId: expect.any(String), bytesWritten: 7 })
		expect(readFileSync(join(workDir, 'notes.txt'), 'utf8')).toBe('durable')
		// The file's own data first, then the directory entry the rename
		// created: a crash between the two would otherwise leave the target
		// naming the old inode with the new data safely on the device and
		// unreachable.
		expect(syncs).toHaveLength(2)
		expect(basename(syncs[0]?.path ?? '')).toMatch(/^\.namzu-write-notes\.txt\..*\.part$/)
		expect(syncs[0]?.flags).toBe('wx')
		expect(syncs[1]?.path).toBe(workDir)
		// And nothing half-written is left inside the workspace.
		expect(strayPartFiles()).toEqual([])
	})

	it('never truncates the target: a write it cannot perform leaves the old bytes', async () => {
		if (IS_ROOT) return
		const port = await startAgent()
		const dir = join(workDir, 'locked')
		await ask(port, 'write-file', { path: 'locked/keep.txt', content: 'original' })
		// A directory the agent cannot create a sibling in is the reachable
		// stand-in for every way the write itself can fail (no space, a
		// read-only mount): the point is what the TARGET looks like
		// afterwards, which is the property the old in-place truncate could
		// not offer at all.
		chmodSync(dir, 0o500)
		try {
			const refused = await ask(port, 'write-file', {
				path: 'locked/keep.txt',
				content: 'replacement',
			})
			expect(refused.ok).toBe(false)
			expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('original')
		} finally {
			chmodSync(dir, 0o700)
		}
		expect(strayPartFiles()).toEqual([])
	})

	it('keeps the mode of a file it replaces, which a rename would otherwise drop', async () => {
		const port = await startAgent()
		const script = join(workDir, 'run.sh')
		writeFileSync(script, '#!/bin/sh\necho old\n')
		chmodSync(script, 0o750)

		const reply = await ask(port, 'write-file', {
			path: 'run.sh',
			content: '#!/bin/sh\necho new\n',
		})

		expect(reply.ok).toBe(true)
		expect(readFileSync(script, 'utf8')).toContain('echo new')
		// The executable bit is the visible half of this; the rest of the
		// mode travels with it. A rename with no `chmod` would have left
		// whatever the umask gave the temp file.
		expect(statSync(script).mode & 0o7777).toBe(0o750)
	})

	it('writes through a symlink to its target, and leaves the link a link', async () => {
		const port = await startAgent()
		const real = join(workDir, 'real.txt')
		writeFileSync(real, 'first')
		symlinkSync(real, join(workDir, 'link.txt'))

		const reply = await ask(port, 'write-file', { path: 'link.txt', content: 'second' })

		expect(reply.ok).toBe(true)
		expect(readFileSync(real, 'utf8')).toBe('second')
		// The temp sibling is a sibling of the RESOLVED path, so the rename
		// replaces the file the link names and the link is still a link — a
		// temp file beside the LINK would have replaced the link with a
		// regular file and quietly detached the two.
		expect(lstatSync(join(workDir, 'link.txt')).isSymbolicLink()).toBe(true)
		expect(existsSync(real)).toBe(true)
		expect(strayPartFiles()).toEqual([])
	})
})

describe.skipIf(IS_WINDOWS)('a body written in parts, made durable', () => {
	/**
	 * Drive one whole part sequence — two frames, the second one the final
	 * part that renames — onto `target`, which the caller has already put
	 * there. Answers the final part's reply.
	 */
	async function writeInParts(
		port: number,
		target: string,
		first: string,
		second: string,
	): Promise<Record<string, unknown>> {
		const temp = `.namzu-write-${basename(target)}.part`
		const started = await ask(port, 'write-file', {
			path: temp,
			content: first,
			part: { offset: 0 },
		})
		expect(started.ok).toBe(true)
		return await ask(port, 'write-file', {
			path: temp,
			content: second,
			part: { offset: Buffer.byteLength(first), final: true, renameTo: target },
		})
	}

	it('fsyncs once at the end, over the whole file, and then the directory', async () => {
		const port = await startAgent()
		const temp = '.namzu-write-big.bin.part'
		const first = await ask(port, 'write-file', {
			path: temp,
			content: Buffer.from('aaaa').toString('base64'),
			encoding: 'base64',
			part: { offset: 0 },
		})
		expect(first.ok).toBe(true)
		// Nothing is fsynced for a part that is not the last one: an
		// abandoned sequence is thrown away rather than renamed, so an
		// unflushed part file is not a durability question, and one fsync
		// per frame would multiply the cost of a large write by the number
		// of frames it took.
		expect(syncs).toEqual([])

		const final = await ask(port, 'write-file', {
			path: temp,
			content: Buffer.from('bbbb').toString('base64'),
			encoding: 'base64',
			part: { offset: 4, final: true, renameTo: 'big.bin' },
		})

		expect(final.ok).toBe(true)
		expect(readFileSync(join(workDir, 'big.bin'), 'utf8')).toBe('aaaabbbb')
		expect(syncs).toHaveLength(2)
		// The fsync is on the TEMP file — one call covering every page the
		// earlier parts left dirty, because fsync writes back the file, not
		// the descriptor.
		expect(basename(syncs[0]?.path ?? '')).toBe(temp)
		expect(syncs[1]?.path).toBe(dirname(join(workDir, 'big.bin')))
		expect(strayPartFiles()).toEqual([])
	})

	/**
	 * The regression these two cases exist for, in the reviewer's own shape:
	 * a part sequence onto a target that is ALREADY there. The final part
	 * renames a temp file the guest created 0o666 through the umask onto the
	 * target, and it did so with no `chmod`, so the reply said `ok`, the
	 * bytes were right, and the target silently came back 0644 — a script
	 * that lost its execute bits, a 0600 file that was no longer private.
	 * The single-frame path had carried the target's mode since #484 made it
	 * durable; the part path, which had been renaming since #475, never did,
	 * and no case asserted either. Both are asserted here, on the real agent
	 * over a real socket.
	 */
	it("carries the target's mode onto the replacement the final part renames in", async () => {
		const port = await startAgent()
		const script = join(workDir, 'run.sh')
		writeFileSync(script, '#!/bin/sh\necho old\n')
		chmodSync(script, 0o755)

		const final = await writeInParts(port, 'run.sh', '#!/bin/sh\n', 'echo new\n')

		expect(final.ok).toBe(true)
		// The bytes matched even while this was broken, so a case that
		// checked only them would have passed against the defect.
		expect(readFileSync(script, 'utf8')).toBe('#!/bin/sh\necho new\n')
		expect(statSync(script).mode & 0o7777).toBe(0o755)
		expect(strayPartFiles()).toEqual([])
	})

	it('does not widen a 0600 target, which a fresh temp file would', async () => {
		const port = await startAgent()
		const secret = join(workDir, 'secret.txt')
		writeFileSync(secret, 'old secret\n')
		chmodSync(secret, 0o600)

		const final = await writeInParts(port, 'secret.txt', 'top ', 'secret\n')

		expect(final.ok).toBe(true)
		expect(readFileSync(secret, 'utf8')).toBe('top secret\n')
		// The same rename, the other direction: a mode the umask would have
		// handed back as 0644.
		expect(statSync(secret).mode & 0o7777).toBe(0o600)
		expect(strayPartFiles()).toEqual([])
	})

	/**
	 * Wrap whatever `fs.open` is installed right now so the handles it
	 * returns refuse `chmod`. Composes with {@link recordSyncs}, which has
	 * already wrapped it, and the `afterEach` restores the real one either
	 * way.
	 *
	 * A `chmod` on a temp file this agent has just created cannot be made to
	 * fail on a filesystem that will let it write and rename there, so the
	 * failure that decides what a refused mode change MEANS is injected
	 * rather than provoked. What is asserted is the decision, not Linux's
	 * permission model.
	 */
	function failEveryChmod(): void {
		const inner = fsPromises.open
		const patched = async (...args: Parameters<typeof fsPromises.open>) => {
			const handle = await inner(...args)
			handle.chmod = async () => {
				throw new Error('EPERM: chmod refused (injected)')
			}
			return handle
		}
		;(fsPromises as { open: typeof fsPromises.open }).open = patched as typeof fsPromises.open
	}

	it('refuses the write rather than renaming a mode it could not apply', async () => {
		const port = await startAgent()
		const script = join(workDir, 'run.sh')
		writeFileSync(script, '#!/bin/sh\necho old\n')
		chmodSync(script, 0o755)
		failEveryChmod()

		const final = await writeInParts(port, 'run.sh', '#!/bin/sh\n', 'echo new\n')

		// Fail closed, loudly: the caller is told, and is left with the file
		// it had — old bytes AND old mode. The alternative, renaming anyway,
		// is the silent permission change this whole case exists to forbid.
		expect(final.ok).toBe(false)
		expect(String(final.error)).toContain('injected')
		expect(readFileSync(script, 'utf8')).toBe('#!/bin/sh\necho old\n')
		expect(statSync(script).mode & 0o7777).toBe(0o755)
		// And nothing was renamed: the temp file is left where every other
		// abandoned sequence leaves one, for the host's `part.discard`.
		expect(strayPartFiles()).toHaveLength(1)
	})
})
