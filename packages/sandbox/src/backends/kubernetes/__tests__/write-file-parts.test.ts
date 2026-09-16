/**
 * `writeFile` for a body larger than one frame, against the REAL guest
 * agent (`agent/agent.cjs`) on a real loopback TCP socket in preset-token
 * mode — the exact mode a routed pod-network deployment runs in.
 *
 * Why this needs its own file rather than a case in `transport.test.ts`:
 * the transport suite is about the `tcp` arm's dial, credential and
 * framing, and every case in it is small and fast. These cases move tens
 * of megabytes through a real agent on purpose, because the defect they
 * exist for is one only a real body reproduces — a `write-file` envelope
 * carries the WHOLE base64 body in the same frame as the token, every
 * request dials a fresh connection, so every request is that connection's
 * first unauthenticated frame and is bounded by the guest's pre-auth
 * ceiling on every call rather than once. Anything above ~5.9 MiB raw was
 * refused, which made seeding a repository archive into a workspace
 * impossible without raising a security bound on the guest.
 *
 * What is asserted here is the fix's whole contract: the body arrives
 * byte-for-byte, the target never exists half-written, an abandoned
 * sequence takes its temp file with it, a lost or misplaced part is
 * refused rather than written, the temp path is jailed exactly as the
 * target is, and a guest too old to advertise the capability is never
 * sent a part it would misread as a whole file.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { type AddressInfo, type Server, type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WRITE_FILE_PARTS_FEATURE } from '../../firecracker/protocol.js'
import {
	AgentPreauthFrameTooLargeError,
	AgentWriteFileTooLargeError,
	TCP_PREAUTH_FRAME_LIMIT_BYTES,
	VsockAgentTransport,
	__framing,
} from '../../firecracker/transport.js'
import { KubernetesAgentTransport } from '../transport.js'
import { AGENT_ENV_KEYS } from './fixtures/agent-env.js'
import { sendFramedRequest } from './fixtures/framed-agent-client.js'

const IS_WINDOWS = process.platform === 'win32'
const require_ = createRequire(import.meta.url)
const AGENT_PATH = '../../../../agent/agent.cjs'
/** The same file as an absolute path, for the suites that spawn it. */
const AGENT_ENTRY_FILE = require_.resolve(AGENT_PATH)

const POD_UID = '6f0b5d2e-2f3a-4b8c-9d1e-77aa0c4f1b32'

/**
 * The default large-body size.
 *
 * The behaviour under test is size-independent above the ceiling, and the
 * only thing a bigger number buys is confidence that nothing in the path
 * is quadratic in the body. 64 MiB proves that in about a second; 256 MiB
 * proves it harder and costs roughly a gigabyte of resident memory in the
 * worker, alongside every other vitest worker on the machine. So 64 MiB
 * runs always and 256 MiB runs when it is asked for:
 *
 *   NAMZU_SANDBOX_HUGE_WRITE_TEST=1 pnpm --filter @namzu/sandbox test
 */
const LARGE_BODY_BYTES = 64 * 1024 * 1024
const HUGE_BODY_BYTES = 256 * 1024 * 1024
const RUN_HUGE = process.env.NAMZU_SANDBOX_HUGE_WRITE_TEST === '1'

interface AgentModule {
	startListening(): Promise<Server>
}

let workDir: string
let listener: Server | undefined
let saved: Record<string, string | undefined>

function clearEnv(keys: readonly string[]): void {
	for (const key of keys) {
		// Unset, not emptied: the agent reads these straight off
		// process.env, where an empty string is not the same as absent.
		delete process.env[key]
	}
}

async function startAgent(token = POD_UID): Promise<{ port: number }> {
	process.env.NAMZU_AGENT_TCP_PORT = '0'
	process.env.NAMZU_AGENT_BIND_TOKEN = token
	delete require_.cache[require_.resolve(AGENT_PATH)]
	const agent = require_(AGENT_PATH) as AgentModule
	listener = await agent.startListening()
	return { port: (listener.address() as AddressInfo).port }
}

function transportFor(port: number, options = {}): KubernetesAgentTransport {
	return new KubernetesAgentTransport(
		{ kind: 'tcp', host: '127.0.0.1', port, token: POD_UID },
		options,
	)
}

/**
 * `size` bytes of deterministic pseudo-random content (xorshift32 from a
 * fixed seed). Pseudo-random so a body reassembled out of order, with a
 * part duplicated or one dropped and padded, fails the comparison — a
 * body of one repeated byte would pass all three. Deterministic so a
 * failure reproduces from the size alone.
 */
function deterministicBytes(size: number): Buffer {
	const out = Buffer.allocUnsafe(size)
	let x = 0x9e3779b9
	for (let i = 0; i < size; i += 1) {
		x ^= x << 13
		x >>>= 0
		x ^= x >> 17
		x ^= x << 5
		x >>>= 0
		out[i] = x & 0xff
	}
	return out
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
	workDir = realpathSync(mkdtempSync(join(tmpdir(), 'k8s-write-parts-')))
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
})

afterEach(async () => {
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

describe.skipIf(IS_WINDOWS)('writeFile in parts, against the real guest agent', () => {
	it('advertises the part capability in its healthz reply', async () => {
		const { port } = await startAgent()
		const reply = await sendFramedRequest(port, { op: 'healthz' })
		expect(reply.reply.protocolVersion).toBe(2)
		// Membership, not equality: `features` is an additive list and the
		// agent grows it, so pinning the whole array would make every later
		// capability a failure here rather than in the suite that owns it.
		expect(reply.reply.features).toContain(WRITE_FILE_PARTS_FEATURE)
	})

	it(`round-trips a ${LARGE_BODY_BYTES / 1024 / 1024} MiB body byte for byte through readFile`, async () => {
		const { port } = await startAgent()
		const transport = transportFor(port)
		const body = deterministicBytes(LARGE_BODY_BYTES)

		await transport.writeFile('seed/repository.tar', body)
		const read = await transport.readFile('seed/repository.tar')

		expect(read.length).toBe(body.length)
		expect(read.equals(body)).toBe(true)
		// The atomic rename is what leaves the workspace clean: no part file
		// survives a sequence that finished.
		expect(strayPartFiles()).toEqual([])
	}, 120_000)

	it.skipIf(!RUN_HUGE)(
		`round-trips a ${HUGE_BODY_BYTES / 1024 / 1024} MiB body byte for byte through readFile`,
		async () => {
			const { port } = await startAgent()
			const transport = transportFor(port)
			const body = deterministicBytes(HUGE_BODY_BYTES)

			await transport.writeFile('seed/huge.tar', body)
			const read = await transport.readFile('seed/huge.tar')

			expect(read.length).toBe(body.length)
			expect(read.equals(body)).toBe(true)
			expect(strayPartFiles()).toEqual([])
		},
		600_000,
	)

	// The size the old ceiling actually refused, not an order of magnitude
	// past it: 7 MiB of content is ~9.3 MiB of base64 envelope, just over
	// the 8 MiB pre-auth frame limit. This is the case a caller hit.
	it('writes a body just over the old single-frame ceiling', async () => {
		const { port } = await startAgent()
		const transport = transportFor(port)
		const body = deterministicBytes(7 * 1024 * 1024)

		await transport.writeFile('just-over.bin', body)

		expect(readFileSync(join(workDir, 'just-over.bin')).equals(body)).toBe(true)
		expect(strayPartFiles()).toEqual([])
	}, 30_000)

	// The other half of that boundary, and the one a regression would break
	// silently: a body that FITS must still travel exactly as it always
	// did — one frame, one connection, no capability probe, no part field.
	it('keeps a body that fits to a single unprobed frame', async () => {
		const { port } = await startAgent()
		let connections = 0
		listener?.on('connection', () => {
			connections += 1
		})
		const transport = transportFor(port)

		await transport.writeFile('small.txt', Buffer.from('a small body'))

		expect(readFileSync(join(workDir, 'small.txt'), 'utf8')).toBe('a small body')
		// One connection: the write itself. A healthz probe for the part
		// capability would be a second, and a part sequence a third.
		expect(connections).toBe(1)
	})

	it('refuses a body above the transport’s configured maximum', async () => {
		const { port } = await startAgent()
		const transport = transportFor(port, { maxWriteFileBytes: 4 * 1024 * 1024 })

		let caught: unknown
		try {
			await transport.writeFile('too-big.bin', deterministicBytes(7 * 1024 * 1024))
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(AgentWriteFileTooLargeError)
		expect((caught as Error).message).toContain(String(4 * 1024 * 1024))
		expect(existsSync(join(workDir, 'too-big.bin'))).toBe(false)
	})

	// The bound is on what a caller may WRITE, not on how the bytes travel.
	// A 4 KiB body fits one frame with room to spare, so nothing about the
	// wire would have stopped it — only the number the host chose does, and
	// it has to say so before anything is dialed.
	it('refuses a body under one frame that is still above the configured maximum', async () => {
		const { port } = await startAgent()
		let connections = 0
		listener?.on('connection', () => {
			connections += 1
		})
		const transport = transportFor(port, { maxWriteFileBytes: 1024 })

		let caught: unknown
		try {
			await transport.writeFile('capped.bin', deterministicBytes(4096))
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(AgentWriteFileTooLargeError)
		expect((caught as Error).message).toContain('1024')
		expect(existsSync(join(workDir, 'capped.bin'))).toBe(false)
		expect(connections).toBe(0)
	})

	it('leaves neither the target nor a part file when the caller aborts mid-transfer', async () => {
		const { port } = await startAgent()
		const controller = new AbortController()
		let connections = 0
		listener?.on('connection', () => {
			connections += 1
			// Connection 1 is the capability probe, 2 the first part. Abort
			// while a later part is on the wire, so the sequence dies with a
			// temp file already on disk and something still to clean up.
			if (connections === 3) controller.abort(new Error('caller cancelled the seed'))
		})
		// 16 parts, so the abort lands in the middle of a real sequence.
		const transport = transportFor(port, { writeFilePartBytes: 64 * 1024 })

		await expect(
			transport.writeFile(
				'aborted/archive.bin',
				deterministicBytes(1024 * 1024),
				controller.signal,
			),
		).rejects.toThrow(/cancelled the seed/)

		expect(existsSync(join(workDir, 'aborted', 'archive.bin'))).toBe(false)
		expect(strayPartFiles()).toEqual([])
	})

	it('leaves the target untouched when the transport fails mid-transfer', async () => {
		const { port } = await startAgent()
		const transport = transportFor(port, {
			writeFilePartBytes: 64 * 1024,
			// A dead peer must be reported as one promptly; the default
			// budget would spend 30 seconds re-dialing a closed listener.
			connectRetryBudgetMs: 200,
			connectRetryIntervalMs: 50,
			connectTimeoutMs: 200,
		})
		await transport.writeFile('standing.bin', Buffer.from('the content that was already there'))

		let connections = 0
		listener?.on('connection', () => {
			connections += 1
			// Probe, part, part — then the peer goes away for good.
			if (connections === 4) listener?.close()
		})

		await expect(
			transport.writeFile('standing.bin', deterministicBytes(1024 * 1024)),
		).rejects.toThrow()

		// The whole point of the rename: a failed write is a write that did
		// not happen, not one that half happened.
		expect(readFileSync(join(workDir, 'standing.bin'), 'utf8')).toBe(
			'the content that was already there',
		)
	}, 30_000)
})

describe.skipIf(IS_WINDOWS)('the guest’s part protocol, driven frame by frame', () => {
	const tempPath = '.namzu-write-fixed-target.bin.part'

	it('appends parts at the offset it is told and renames onto the target', async () => {
		const { port } = await startAgent()

		const first = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: tempPath,
				content: Buffer.from('hello ').toString('base64'),
				encoding: 'base64',
				part: { offset: 0, final: false },
			},
		})
		expect(first.reply).toMatchObject({ ok: true, bytesWritten: 6, sizeBytes: 6 })
		// The target does not exist yet: only the final rename creates it.
		expect(existsSync(join(workDir, 'target.bin'))).toBe(false)

		const second = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: tempPath,
				content: Buffer.from('world').toString('base64'),
				encoding: 'base64',
				part: { offset: 6, final: true, renameTo: 'target.bin' },
			},
		})
		expect(second.reply).toMatchObject({ ok: true, sizeBytes: 11 })
		expect(readFileSync(join(workDir, 'target.bin'), 'utf8')).toBe('hello world')
		expect(existsSync(join(workDir, tempPath))).toBe(false)
	})

	it('refuses a part whose offset does not match the temp file’s size', async () => {
		const { port } = await startAgent()
		await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: tempPath,
				content: Buffer.from('hello ').toString('base64'),
				encoding: 'base64',
				part: { offset: 0, final: false },
			},
		})

		// A part that believes it follows more content than was actually
		// written — the shape a dropped part takes.
		const ahead = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: tempPath,
				content: Buffer.from('world').toString('base64'),
				encoding: 'base64',
				part: { offset: 99, final: true, renameTo: 'target.bin' },
			},
		})
		expect(ahead.reply.ok).toBe(false)
		expect(String(ahead.reply.error)).toContain('write_part_offset_mismatch')

		// And the shape a duplicated part takes: an offset already covered.
		const behind = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: tempPath,
				content: Buffer.from('world').toString('base64'),
				encoding: 'base64',
				part: { offset: 3, final: false },
			},
		})
		expect(behind.reply.ok).toBe(false)
		expect(String(behind.reply.error)).toContain('write_part_offset_mismatch')

		// Neither was applied, and no target was produced from a body the
		// guest could not vouch for.
		expect(readFileSync(join(workDir, tempPath), 'utf8')).toBe('hello ')
		expect(existsSync(join(workDir, 'target.bin'))).toBe(false)
	})

	it('refuses a final part that names no rename target', async () => {
		const { port } = await startAgent()
		const reply = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: tempPath,
				content: Buffer.from('x').toString('base64'),
				encoding: 'base64',
				part: { offset: 0, final: true },
			},
		})
		expect(reply.reply.ok).toBe(false)
		expect(reply.reply.error).toBe('write_part_missing_rename_target')
	})

	// The temp path and the rename target are paths a caller supplies, so
	// both go through the same jail every other write does — a part
	// protocol that reached outside the workspace would be a way around it.
	it('jails the temp path and the rename target exactly as a whole write is jailed', async () => {
		const { port } = await startAgent()

		const escapingTemp = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: '../escaped.part',
				content: Buffer.from('x').toString('base64'),
				encoding: 'base64',
				part: { offset: 0, final: false },
			},
		})
		expect(escapingTemp.reply.ok).toBe(false)
		expect(String(escapingTemp.reply.error)).toContain('escapes the workspace')

		await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: tempPath,
				content: Buffer.from('x').toString('base64'),
				encoding: 'base64',
				part: { offset: 0, final: false },
			},
		})
		const escapingRename = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: tempPath,
				content: Buffer.from('y').toString('base64'),
				encoding: 'base64',
				part: { offset: 1, final: true, renameTo: '../escaped.bin' },
			},
		})
		expect(escapingRename.reply.ok).toBe(false)
		expect(String(escapingRename.reply.error)).toContain('escapes the workspace')
		// Refused BEFORE the part's bytes land: `renameTo` goes through the
		// jail first, so a final part with a target outside the workspace is
		// a true no-op rather than a refusal that already appended.
		expect(readFileSync(join(workDir, tempPath), 'utf8')).toBe('x')
	})

	// `discard` is the only verb on `write-file` that REMOVES a file. It
	// exists to clean up after an abandoned sequence, so it reaches the
	// agent's own part files and nothing else.
	it('refuses to discard a path that is not one of its part files', async () => {
		const { port } = await startAgent()
		await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: { path: 'precious.txt', content: 'keep me', encoding: 'utf8' },
		})

		const reply = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: { path: 'precious.txt', content: '', encoding: 'base64', part: { discard: true } },
		})

		expect(reply.reply).toMatchObject({ ok: false, error: 'write_part_not_a_temp_file' })
		expect(readFileSync(join(workDir, 'precious.txt'), 'utf8')).toBe('keep me')

		// Refused on the name alone, whether or not anything is there — and
		// without creating the directory it would have looked in. A verb whose
		// whole job is to leave nothing behind leaves nothing behind.
		const absent = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: { path: 'gone/precious.txt', content: '', encoding: 'base64', part: { discard: true } },
		})
		expect(absent.reply).toMatchObject({ ok: false, error: 'write_part_not_a_temp_file' })
		expect(existsSync(join(workDir, 'gone'))).toBe(false)
	})

	// The cleanup the host sends after a sequence that died before its first
	// part landed names a temp file in a directory nothing ever created.
	// There is no such file, so the honest answer is "done" — a host
	// retrying a cleanup must never be told it failed at something already
	// true — and the directory must still not exist afterwards.
	it('reports a discard done when the part file’s directory was never created', async () => {
		const { port } = await startAgent()

		const reply = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: `never/created/${tempPath}`,
				content: '',
				encoding: 'base64',
				part: { discard: true },
			},
		})

		expect(reply.reply).toMatchObject({ ok: true, discarded: true })
		expect(existsSync(join(workDir, 'never'))).toBe(false)
	})

	// An array is `typeof 'object'`, so without a guard it would read as a
	// part with every field undefined — a whole-file write under an op shape
	// claiming to be something else.
	it('refuses a part that is present but is not an object', async () => {
		const { port } = await startAgent()

		const reply = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: 'not-a-part.bin',
				content: Buffer.from('smuggled').toString('base64'),
				encoding: 'base64',
				part: [],
			},
		})

		expect(reply.reply).toMatchObject({ ok: false, error: 'write_part_invalid_shape' })
		expect(existsSync(join(workDir, 'not-a-part.bin'))).toBe(false)
	})

	it('discards a temp file on request and says so', async () => {
		const { port } = await startAgent()
		await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: tempPath,
				content: Buffer.from('abandoned').toString('base64'),
				encoding: 'base64',
				part: { offset: 0, final: false },
			},
		})
		expect(existsSync(join(workDir, tempPath))).toBe(true)

		const discard = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: { path: tempPath, content: '', encoding: 'base64', part: { discard: true } },
		})
		expect(discard.reply).toMatchObject({ ok: true, discarded: true })
		expect(existsSync(join(workDir, tempPath))).toBe(false)

		// Idempotent: a host retrying a cleanup must not be told it failed.
		const again = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: { path: tempPath, content: '', encoding: 'base64', part: { discard: true } },
		})
		expect(again.reply).toMatchObject({ ok: true, discarded: true })
	})

	// Two writers racing on one temp file must never produce a file that is
	// neither of theirs. The in-flight lock refuses the overlap outright;
	// when the two happen not to overlap they simply serialize. Both are
	// compliant, and the assertion is what holds in either case.
	it('never blends two concurrent writers into one temp file', async () => {
		const { port } = await startAgent()
		const a = Buffer.alloc(2 * 1024 * 1024, 0x61)
		const b = Buffer.alloc(2 * 1024 * 1024, 0x62)
		const send = (content: Buffer) =>
			sendFramedRequest(port, {
				op: 'write-file',
				token: POD_UID,
				body: {
					path: tempPath,
					content: content.toString('base64'),
					encoding: 'base64',
					part: { offset: 0, final: false },
				},
			})

		const replies = await Promise.all([send(a), send(b)])
		for (const reply of replies) {
			if (reply.reply.ok === true) continue
			expect(reply.reply.error).toBe('write_part_in_flight')
		}
		const written = readFileSync(join(workDir, tempPath))
		expect(written.equals(a) || written.equals(b)).toBe(true)
	}, 30_000)
})

/**
 * A part the guest accepted but could not write in full.
 *
 * `FileHandle.write` is one `pwrite`, not a loop, and Linux answers a
 * write that crosses the filesystem's free space or the process's
 * `RLIMIT_FSIZE` with a SHORT count and no error whatsoever. On a
 * non-final part the next part's offset check catches that; the final
 * part has no next part, and renaming a truncated temp file onto the
 * target would destroy exactly the contents the atomic rename exists to
 * protect — while the host, which compares sizes only after the reply,
 * reported a failure it could no longer undo. A workspace volume filling
 * up on the last part of a large seed is the scenario this whole feature
 * was written for.
 *
 * The limit is imposed for real rather than stubbed: the agent runs in a
 * child process under `ulimit -f`, so the short write comes from the
 * kernel, which is the only place it ever comes from in production.
 */
describe.skipIf(IS_WINDOWS)('a part the guest cannot write in full', () => {
	const tempPath = '.namzu-write-target.bin.part'
	let child: ChildProcess | undefined

	afterEach(() => {
		if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
		child = undefined
	})

	/**
	 * The real agent in a child process whose files may not grow past
	 * `blocks` shell blocks, resolving the port it bound.
	 *
	 * The port comes back from the child itself, because reserving one here
	 * and handing it over is a race. `-e` runs the agent's own exported
	 * `startListening`, so what is under the limit is the shipped file.
	 */
	async function startLimitedAgent(blocks: number): Promise<number> {
		const boot =
			'require(process.argv[1]).startListening().then((s) => console.log(JSON.stringify({ port: s.address().port })))'
		// Built rather than inherited. Under a file-size limit this small,
		// anything the runner asked a child node to write on exit — a
		// NODE_V8_COVERAGE profile above all — is a fatal SIGXFSZ instead of
		// the short write under test.
		const env: NodeJS.ProcessEnv = {
			PATH: process.env.PATH,
			NAMZU_AGENT_TCP_PORT: '0',
			NAMZU_AGENT_BIND_TOKEN: POD_UID,
			NAMZU_SANDBOX_WORKSPACE: workDir,
		}
		child = spawn(
			'/bin/sh',
			[
				'-c',
				`ulimit -f ${blocks}; exec "$0" -e "$1" "$2"`,
				process.execPath,
				boot,
				AGENT_ENTRY_FILE,
			],
			{ env, stdio: ['ignore', 'pipe', 'pipe'] },
		)
		const spawned = child
		return await new Promise<number>((resolve, reject) => {
			let out = ''
			let errors = ''
			const timer = setTimeout(() => {
				reject(new Error(`the limited agent never reported a port: ${out}${errors}`))
			}, 20_000)
			timer.unref()
			spawned.stderr?.on('data', (chunk: Buffer) => {
				errors += chunk.toString('utf8')
			})
			spawned.stdout?.on('data', (chunk: Buffer) => {
				out += chunk.toString('utf8')
				// Whole lines only: a port half-delivered is not a port.
				const line = out
					.split('\n')
					.find((candidate) => candidate.includes('"port"') && candidate.trim().endsWith('}'))
				if (!line) return
				clearTimeout(timer)
				resolve((JSON.parse(line) as { port: number }).port)
			})
			spawned.once('error', reject)
			spawned.once('exit', (code, signal) => {
				clearTimeout(timer)
				reject(new Error(`the limited agent exited (code=${code}, signal=${signal}) ${errors}`))
			})
		})
	}

	it('refuses a final part it could not write in full, and renames nothing', async () => {
		// One block is 512 or 1024 bytes depending on the shell, so the two
		// parts are sized to behave the same either way: the first fits under
		// the smaller reading, the second cannot fit under the larger one.
		const port = await startLimitedAgent(1)
		writeFileSync(join(workDir, 'target.bin'), 'the content that was already there')

		const first = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: tempPath,
				content: Buffer.alloc(100, 0x61).toString('base64'),
				encoding: 'base64',
				part: { offset: 0, final: false },
			},
		})
		expect(first.reply).toMatchObject({ ok: true, bytesWritten: 100, sizeBytes: 100 })

		// This one asks for far more than the limit leaves: the kernel writes
		// what it can, reports that count, and raises nothing.
		const second = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: tempPath,
				content: Buffer.alloc(64 * 1024, 0x62).toString('base64'),
				encoding: 'base64',
				part: { offset: 100, final: true, renameTo: 'target.bin' },
			},
		})

		expect(second.reply.ok).toBe(false)
		expect(String(second.reply.error)).toContain('write_part_short_write')
		// The rename never happened, so the target is the file it always was
		// and the truncated bytes are still in the temp file the host will
		// ask to have discarded.
		expect(readFileSync(join(workDir, 'target.bin'), 'utf8')).toBe(
			'the content that was already there',
		)
		expect(existsSync(join(workDir, tempPath))).toBe(true)
	}, 30_000)
})

/**
 * A guest that answers `healthz` the way every agent before this release
 * did — `ok` and a protocol version, and no `features` at all.
 *
 * The host must never send such a guest a part: `write-file`'s `path` names
 * the TEMP file while `part` is present, so an agent that dropped the field
 * would write one part's worth of content to a file nobody asked for and
 * report success. So the rule is the guest opts IN, and a host that does
 * not hear the opt-in keeps to the single frame and its named refusal.
 */
describe('a guest that does not advertise the part capability', () => {
	let server: Server | undefined
	let requests: Record<string, unknown>[] = []

	beforeEach(async () => {
		requests = []
		server = createServer((socket: Socket) => {
			const reader = new __framing.FrameReader()
			socket.on('data', (chunk: Buffer) => {
				for (const payload of reader.push(chunk)) {
					const request = JSON.parse(payload) as Record<string, unknown>
					requests.push(request)
					const reply =
						request.op === 'healthz'
							? { ok: true, protocolVersion: 2 }
							: { ok: true, bytesWritten: 0 }
					socket.end(__framing.frame(JSON.stringify(reply)))
				}
			})
		})
		await new Promise<void>((resolve, reject) => {
			server?.once('error', reject)
			server?.listen(0, '127.0.0.1', resolve)
		})
	})

	afterEach(async () => {
		if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
		server = undefined
	})

	function transport(): VsockAgentTransport {
		const { port } = server?.address() as AddressInfo
		return new VsockAgentTransport({ kind: 'tcp', host: '127.0.0.1', port, token: POD_UID })
	}

	it('still serves a small body on the plain single-frame path', async () => {
		await transport().writeFile('small.txt', Buffer.from('fits in one frame'))

		expect(requests).toHaveLength(1)
		expect(requests[0]?.op).toBe('write-file')
		expect((requests[0]?.body as Record<string, unknown>).part).toBeUndefined()
	})

	it('refuses a large body with the named pre-auth error, having sent no part', async () => {
		let caught: unknown
		try {
			await transport().writeFile('too-big.bin', Buffer.alloc(7 * 1024 * 1024, 0x63))
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(AgentPreauthFrameTooLargeError)
		expect((caught as Error).message).toContain(String(TCP_PREAUTH_FRAME_LIMIT_BYTES))
		expect((caught as Error).message).toContain(WRITE_FILE_PARTS_FEATURE)
		// It asked, it was not told yes, and it stopped: the only thing on
		// the wire is the capability probe.
		expect(requests.map((request) => request.op)).toEqual(['healthz'])
	})
})
