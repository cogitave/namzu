/**
 * Ranged and streamed `readFile`, against the REAL guest agent
 * (`agent/agent.cjs`) on a real loopback TCP socket in preset-token mode —
 * the exact mode a routed pod-network deployment runs in.
 *
 * Why this needs its own file rather than cases in `transport.test.ts`:
 * the defect it exists for is a MEMORY defect, and a memory defect is only
 * visible against a real file and a real process. The old whole-file read
 * held the file buffer, its base64 string, the JSON string and two frame
 * buffers at once — about 7.7x the file — so a 64 MiB read peaked around
 * 542 MiB, above the shipped workspace template's `512Mi` limit, in the
 * container the workload shares. Above about 384 MiB it could not answer
 * at all: the base64 string is longer than V8 lets a string be.
 *
 * So the agent runs in a CHILD process here, not in this worker, for one
 * reason: `VmHWM` from `/proc/<pid>/status` is the peak resident size of
 * one process, and the in-process fixture's peak is vitest's. The pid read
 * is the agent's own — under the shipped image `tini` is PID 1
 * (`k8s/entrypoint.sh`), so `/proc/1` would measure the init.
 *
 * Every memory assertion is paired with a POSITIVE CONTROL that drives the
 * old whole-file path through the same measurement on the same file, so a
 * measurement that cannot see the difference fails loudly rather than
 * passing both ways.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { open, readFile as readFileFromDisk } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { type AddressInfo, type Server, type Socket, connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { READ_FILE_STREAM_FEATURE, WRITE_FILE_PARTS_FEATURE } from '../../firecracker/protocol.js'
import {
	AgentReadFileStreamUnsupportedError,
	VsockAgentTransport,
	__framing,
} from '../../firecracker/transport.js'
import { KubernetesAgentTransport } from '../transport.js'
import { AGENT_ENV_KEYS } from './fixtures/agent-env.js'
import { encodeFrame, sendFramedRequest } from './fixtures/framed-agent-client.js'

const IS_LINUX = process.platform === 'linux'
const IS_WINDOWS = process.platform === 'win32'
const require_ = createRequire(import.meta.url)
const AGENT_PATH = '../../../../agent/agent.cjs'
const AGENT_ENTRY_FILE = require_.resolve(AGENT_PATH)

const POD_UID = '6f0b5d2e-2f3a-4b8c-9d1e-77aa0c4f1b32'

/**
 * The file the memory cases move.
 *
 * Chosen against the issue's own measurement rather than as a round
 * number: the whole-file path grew the agent by about 7.7x the file, so
 * 32 MiB pushes the control a quarter of a gigabyte past the 64 MiB
 * budget the streamed path is held to — decisive in both directions, and
 * cheap enough to run on every CI leg.
 */
const MEMORY_CASE_BYTES = 32 * 1024 * 1024
/** The budget the streamed path must stay inside. From the issue's acceptance. */
const STREAM_MEMORY_BUDGET_BYTES = 64 * 1024 * 1024
/**
 * The file the backpressure case holds open.
 *
 * Bigger than the memory cases because the question is different: with no
 * backpressure the guest reads ahead as fast as the disk allows and parks
 * the rest of the file in its own socket write queue, so the file has to
 * be large enough that "the rest of it" would blow the budget on its own.
 * 128 MiB does; 32 MiB would sit close enough to the budget to prove
 * nothing either way.
 */
const SLOW_CONSUMER_BYTES = 128 * 1024 * 1024

/**
 * The acceptance sizes: a 1 GiB stream compared against the guest's own
 * `sha256sum`, and a 256 MiB whole-file `readFile`. Both write a real file
 * of that size to a real temp directory and move every byte of it, which
 * is minutes of wall time and gigabytes of disk between them, so neither
 * runs by default:
 *
 *   NAMZU_SANDBOX_GIANT_READ_TEST=1 pnpm --filter @namzu/sandbox test
 */
const GIANT_STREAM_BYTES = 1024 * 1024 * 1024
const GIANT_WHOLE_BYTES = 256 * 1024 * 1024
const RUN_GIANT = process.env.NAMZU_SANDBOX_GIANT_READ_TEST === '1'

interface AgentModule {
	startListening(): Promise<Server>
}

let workDir: string
let listener: Server | undefined
/**
 * Every child agent this file spawned, so `afterEach` reaps them all. A
 * list rather than one handle because the descriptor-leak case runs two
 * agents side by side — the shipped one and a deliberately broken copy.
 */
let children: ChildProcess[]
let saved: Record<string, string | undefined>

function clearEnv(keys: readonly string[]): void {
	for (const key of keys) {
		// Unset, not emptied: the agent reads these straight off
		// process.env, where an empty string is not the same as absent.
		delete process.env[key]
	}
}

/** The real agent in THIS worker, for the cases that do not measure memory. */
async function startAgent(extra: Record<string, string> = {}): Promise<{ port: number }> {
	process.env.NAMZU_AGENT_TCP_PORT = '0'
	process.env.NAMZU_AGENT_BIND_TOKEN = POD_UID
	for (const [key, value] of Object.entries(extra)) process.env[key] = value
	delete require_.cache[require_.resolve(AGENT_PATH)]
	const agent = require_(AGENT_PATH) as AgentModule
	listener = await agent.startListening()
	return { port: (listener.address() as AddressInfo).port }
}

/**
 * The real agent in a CHILD process, resolving the port it bound and its
 * own pid.
 *
 * The port comes back from the child itself, because reserving one here
 * and handing it over is a race. `-e` runs the agent's own exported
 * `startListening`, so what is measured is the shipped file.
 */
async function startChildAgent(
	extra: Record<string, string> = {},
	entryFile: string = AGENT_ENTRY_FILE,
): Promise<{
	port: number
	pid: number
}> {
	const boot =
		'require(process.argv[1]).startListening().then((s) => console.log(JSON.stringify({ port: s.address().port })))'
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		NAMZU_AGENT_TCP_PORT: '0',
		NAMZU_AGENT_BIND_TOKEN: POD_UID,
		NAMZU_SANDBOX_WORKSPACE: workDir,
		...extra,
	}
	const spawned = spawn(process.execPath, ['-e', boot, entryFile], {
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	children.push(spawned)
	const port = await new Promise<number>((resolve, reject) => {
		let out = ''
		let errors = ''
		const timer = setTimeout(
			() => reject(new Error(`the child agent never reported a port: ${out}${errors}`)),
			20_000,
		)
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
			reject(new Error(`the child agent exited (code=${code}, signal=${signal}) ${errors}`))
		})
	})
	if (spawned.pid === undefined) throw new Error('the child agent has no pid')
	return { port, pid: spawned.pid }
}

/** Peak resident set size of one process, in bytes. Linux only. */
async function peakResidentBytes(pid: number): Promise<number> {
	const status = await readFileFromDisk(`/proc/${pid}/status`, 'utf8')
	const line = status.split('\n').find((candidate) => candidate.startsWith('VmHWM:'))
	if (!line) throw new Error(`no VmHWM in /proc/${pid}/status`)
	const kb = Number(line.replace(/[^0-9]/g, ''))
	return kb * 1024
}

/** How many descriptors a process holds. Linux only. */
function openDescriptorCount(pid: number): number {
	return readdirSync(`/proc/${pid}/fd`).length
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
 * chunk duplicated or one dropped and padded, fails the comparison — a
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

function digest(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex')
}

/** Write `size` bytes to `name` without ever holding more than 8 MiB of them. */
function writeLargeFile(name: string, size: number): string {
	const block = deterministicBytes(Math.min(size, 8 * 1024 * 1024))
	const hash = createHash('sha256')
	const path = join(workDir, name)
	writeFileSync(path, Buffer.alloc(0))
	let written = 0
	while (written < size) {
		const slice = block.subarray(0, Math.min(block.length, size - written))
		writeFileSync(path, slice, { flag: 'a' })
		hash.update(slice)
		written += slice.length
	}
	return hash.digest('hex')
}

beforeEach(() => {
	saved = Object.fromEntries(AGENT_ENV_KEYS.map((key) => [key, process.env[key]]))
	clearEnv(AGENT_ENV_KEYS)
	workDir = realpathSync(mkdtempSync(join(tmpdir(), 'k8s-read-stream-')))
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
	children = []
})

afterEach(async () => {
	if (listener) {
		await new Promise<void>((resolve) => listener?.close(() => resolve()))
		listener = undefined
	}
	for (const spawned of children) {
		if (spawned.exitCode === null && spawned.signalCode === null) spawned.kill('SIGKILL')
	}
	children = []
	clearEnv(AGENT_ENV_KEYS)
	for (const [key, value] of Object.entries(saved)) {
		if (value !== undefined) process.env[key] = value
	}
	rmSync(workDir, { recursive: true, force: true })
})

describe.skipIf(IS_WINDOWS)('the guest advertises ranged and streamed reads', () => {
	it('names the capability in its healthz reply, beside the write-side one', async () => {
		const { port } = await startAgent()
		const health = await sendFramedRequest(port, { op: 'healthz' })
		expect(health.reply.protocolVersion).toBe(2)
		// The protocol version is deliberately unchanged: a bump would
		// strand every deployed guest for a feature none of them has to use.
		// Membership, not equality: `features` is an additive list and the
		// agent grows it independently of this suite (execution-attach,
		// stream-heartbeat), so pinning the whole array would make every
		// later capability a failure here rather than in the suite that
		// owns it.
		expect(health.reply.features).toContain(WRITE_FILE_PARTS_FEATURE)
		expect(health.reply.features).toContain(READ_FILE_STREAM_FEATURE)
	})
})

describe.skipIf(IS_WINDOWS)('readFile, ranged', () => {
	it('returns exactly the requested bytes and the whole file’s size', async () => {
		const { port } = await startAgent()
		const payload = deterministicBytes(64 * 1024)
		writeFileSync(join(workDir, 'ranged.bin'), payload)

		const slice = await transportFor(port).readFile('ranged.bin', { offset: 1_000, length: 256 })
		expect(slice.equals(payload.subarray(1_000, 1_256))).toBe(true)

		// `sizeBytes` describes the FILE, not the slice — it is how a caller
		// stepping through a file knows where to stop.
		const framed = await sendFramedRequest(port, {
			op: 'read-file',
			token: POD_UID,
			body: { path: 'ranged.bin', encoding: 'base64', offset: 1_000, length: 256 },
		})
		expect(framed.reply).toMatchObject({
			ok: true,
			sizeBytes: payload.length,
			offset: 1_000,
			bytesRead: 256,
		})
	})

	it('returns the bytes that exist when the range runs past the end', async () => {
		const { port } = await startAgent()
		const payload = deterministicBytes(1_000)
		writeFileSync(join(workDir, 'short.bin'), payload)
		const transport = transportFor(port)

		const straddling = await transport.readFile('short.bin', { offset: 900, length: 500 })
		expect(straddling.equals(payload.subarray(900))).toBe(true)

		// Wholly past the end is an empty answer, not a failure: a caller
		// resuming from a remembered offset has to be able to ask without
		// knowing the answer first.
		const beyond = await transport.readFile('short.bin', { offset: 5_000, length: 100 })
		expect(beyond.length).toBe(0)
	})

	it('refuses a range above the guest’s per-frame ceiling, naming the variable', async () => {
		const { port } = await startAgent({ NAMZU_AGENT_READ_FILE_RANGE_BYTES: '4096' })
		writeFileSync(join(workDir, 'capped.bin'), deterministicBytes(64 * 1024))

		await expect(
			transportFor(port).readFile('capped.bin', { offset: 0, length: 8_192 }),
		).rejects.toThrow(/read_file_range_too_large[\s\S]*NAMZU_AGENT_READ_FILE_RANGE_BYTES/)
	})

	// A range with no length is an unbounded tail, which is what the
	// ceiling above exists to refuse — so the transport sends it to the
	// stream instead of to a `read-file` the guest would turn down.
	it('serves an offset with no length through the stream', async () => {
		const { port } = await startAgent({ NAMZU_AGENT_READ_FILE_RANGE_BYTES: '4096' })
		const payload = deterministicBytes(256 * 1024)
		writeFileSync(join(workDir, 'tail.bin'), payload)

		const tail = await transportFor(port).readFile('tail.bin', { offset: 200_000 })
		expect(tail.equals(payload.subarray(200_000))).toBe(true)
	})

	it('refuses an offset or length that is not a non-negative safe integer', async () => {
		const { port } = await startAgent()
		writeFileSync(join(workDir, 'ok.bin'), Buffer.from('content'))
		const transport = transportFor(port)

		await expect(transport.readFile('ok.bin', { offset: -1, length: 1 })).rejects.toThrow(/offset/)
		await expect(transport.readFile('ok.bin', { offset: 0, length: -1 })).rejects.toThrow(/length/)
		await expect(transport.readFile('ok.bin', { offset: 1.5, length: 1 })).rejects.toThrow(/offset/)
	})

	/**
	 * The sibling of `reads a regular file whose stat reports no size at
	 * all` below, on the ranged shape — and the harder half of it, because
	 * every number a range is made of comes from the size `stat` refuses to
	 * give. Answered off `stat.size` alone, this read returns an empty
	 * buffer beside `sizeBytes: 0`: the caller is told the file is empty,
	 * which is a wrong answer rather than a short one, and nothing in the
	 * reply lets it tell the difference.
	 */
	it.skipIf(!IS_LINUX)('answers a ranged read of a file stat reports as empty', async () => {
		// The premise, asserted rather than assumed: if this ever stops
		// being a sizeless file the case proves nothing and should say so.
		expect(statSync('/proc/version').isFile()).toBe(true)
		expect(statSync('/proc/version').size).toBe(0)
		const expected = readFileSync('/proc/version')
		expect(expected.length).toBeGreaterThan(8)

		const { port } = await startAgent({ NAMZU_SANDBOX_READ_ROOTS: '/proc' })
		const slice = await transportFor(port).readFile('/proc/version', { offset: 2, length: 6 })
		expect(slice.equals(expected.subarray(2, 8))).toBe(true)

		// `sizeBytes` describes the whole file here too, which is the only
		// way a caller stepping through one of these knows where to stop.
		const framed = await sendFramedRequest(port, {
			op: 'read-file',
			token: POD_UID,
			body: { path: '/proc/version', encoding: 'base64', offset: 0, length: 4096 },
		})
		expect(framed.reply).toMatchObject({
			ok: true,
			sizeBytes: expected.length,
			offset: 0,
			bytesRead: expected.length,
		})
	})

	/**
	 * A slice is bytes, and `utf8` is not a way to carry arbitrary bytes: a
	 * range that starts or ends inside a multi-byte character would come
	 * back as replacement characters and read as content. The host always
	 * asks for base64, so this is a guard on the wire shape rather than on
	 * any call in this repository — the ranged fields are new in this
	 * release, so no existing caller can be relying on the other answer.
	 */
	it('refuses a ranged read that asks for anything but base64', async () => {
		const { port } = await startAgent()
		writeFileSync(join(workDir, 'text.bin'), Buffer.from('héllo wörld'))

		const framed = await sendFramedRequest(port, {
			op: 'read-file',
			token: POD_UID,
			body: { path: 'text.bin', encoding: 'utf8', offset: 1, length: 2 },
		})
		expect(framed.reply).toMatchObject({ ok: false })
		expect(String(framed.reply.error)).toContain('read_file_range_requires_base64')

		// The whole-file shape keeps `utf8`: its boundaries are the file's.
		const whole = await sendFramedRequest(port, {
			op: 'read-file',
			token: POD_UID,
			body: { path: 'text.bin', encoding: 'utf8' },
		})
		expect(whole.reply).toMatchObject({ ok: true, content: 'héllo wörld' })
	})
})

describe.skipIf(IS_WINDOWS)('readFileStream', () => {
	it('yields the file in order, byte for byte', async () => {
		const { port } = await startAgent()
		const payload = deterministicBytes(9 * 1024 * 1024)
		writeFileSync(join(workDir, 'archive.bin'), payload)

		const chunks: Buffer[] = []
		for await (const chunk of transportFor(port).readFileStream('archive.bin')) chunks.push(chunk)

		// Deliberately above the 8 MiB pre-auth frame ceiling: the size at
		// which nothing about this may travel in one request frame.
		expect(chunks.length).toBeGreaterThan(1)
		const joined = Buffer.concat(chunks)
		expect(joined.length).toBe(payload.length)
		expect(digest(joined)).toBe(digest(payload))
	}, 60_000)

	it('yields nothing for an empty file and still terminates', async () => {
		const { port } = await startAgent()
		writeFileSync(join(workDir, 'empty.bin'), Buffer.alloc(0))

		const chunks: Buffer[] = []
		for await (const chunk of transportFor(port).readFileStream('empty.bin')) chunks.push(chunk)
		expect(chunks).toEqual([])
	})

	it('streams a range when one is asked for', async () => {
		const { port } = await startAgent({ NAMZU_AGENT_READ_FILE_STREAM_CHUNK_BYTES: '4096' })
		const payload = deterministicBytes(64 * 1024)
		writeFileSync(join(workDir, 'sliced.bin'), payload)

		const chunks: Buffer[] = []
		for await (const chunk of transportFor(port).readFileStream('sliced.bin', {
			offset: 10_000,
			length: 20_000,
		})) {
			chunks.push(chunk)
		}
		expect(Buffer.concat(chunks).equals(payload.subarray(10_000, 30_000))).toBe(true)
	})

	// An abort is answered BEFORE the decoded queue, so a consumer that
	// aborts sees the rejection rather than up to a high-water mark of
	// bytes the guest had already put on the wire. Yielding those would
	// make `signal` a request rather than the prompt refusal it promises.
	it('yields nothing more once the caller aborts', async () => {
		const { port } = await startAgent({
			NAMZU_AGENT_READ_FILE_STREAM_CHUNK_BYTES: String(64 * 1024),
		})
		writeFileSync(join(workDir, 'aborted-early.bin'), deterministicBytes(16 * 1024 * 1024))

		const controller = new AbortController()
		let taken = 0
		let atAbort: number | undefined
		await expect(async () => {
			for await (const chunk of transportFor(port).readFileStream('aborted-early.bin', {
				signal: controller.signal,
			})) {
				taken += chunk.length
				if (atAbort !== undefined) continue
				// Hold before aborting, so the guest fills this side's decode
				// queue to its high-water mark first. Aborting against an
				// empty queue would pass however the loop is ordered.
				await new Promise((resolve) => setTimeout(resolve, 250))
				controller.abort(new Error('one chunk was enough'))
				atAbort = taken
			}
		}).rejects.toThrow(/one chunk was enough/)

		expect(atAbort).toBeGreaterThan(0)
		expect(taken).toBe(atAbort)
	})

	it('refuses a directory rather than streaming whatever the fd yields', async () => {
		const { port } = await startAgent()
		writeFileSync(join(workDir, 'dir-marker.txt'), 'x')

		await expect(async () => {
			for await (const _chunk of transportFor(port).readFileStream('.')) {
				// The refusal arrives before the first chunk.
			}
		}).rejects.toThrow(/read_file_stream_not_a_regular_file/)
	})
})

describe.skipIf(IS_WINDOWS)('the workspace jail covers both new read shapes', () => {
	it('refuses `..` on a ranged read and on a stream', async () => {
		const { port } = await startAgent()
		writeFileSync(join(workDir, '..', 'outside-range.txt'), 'secret')
		const transport = transportFor(port)

		await expect(
			transport.readFile('../outside-range.txt', { offset: 0, length: 6 }),
		).rejects.toThrow(/escapes the workspace/)
		await expect(async () => {
			for await (const _chunk of transport.readFileStream('../outside-range.txt')) {
				// never reached
			}
		}).rejects.toThrow(/escapes the workspace/)

		rmSync(join(workDir, '..', 'outside-range.txt'), { force: true })
	})

	it('refuses a symlink that leaves the workspace, on both shapes', async () => {
		const { port } = await startAgent()
		const outside = join(workDir, '..', `outside-link-${process.pid}.txt`)
		writeFileSync(outside, 'secret')
		symlinkSync(outside, join(workDir, 'link.txt'))
		const transport = transportFor(port)

		await expect(transport.readFile('link.txt', { offset: 0, length: 6 })).rejects.toThrow(
			/symlink escapes the workspace/,
		)
		await expect(async () => {
			for await (const _chunk of transport.readFileStream('link.txt')) {
				// never reached
			}
		}).rejects.toThrow(/symlink escapes the workspace/)

		rmSync(outside, { force: true })
	})
})

describe.skipIf(IS_WINDOWS || !IS_LINUX)('what a stream costs the guest', () => {
	it('keeps the agent’s peak resident size inside the budget', async () => {
		const expected = writeLargeFile('measured.bin', MEMORY_CASE_BYTES)
		const { port, pid } = await startChildAgent()
		const before = await peakResidentBytes(pid)

		const hash = createHash('sha256')
		let bytes = 0
		for await (const chunk of transportFor(port).readFileStream('measured.bin')) {
			hash.update(chunk)
			bytes += chunk.length
		}

		expect(bytes).toBe(MEMORY_CASE_BYTES)
		expect(hash.digest('hex')).toBe(expected)
		const growth = (await peakResidentBytes(pid)) - before
		expect(growth).toBeLessThan(STREAM_MEMORY_BUDGET_BYTES)
	}, 120_000)

	// The positive control. Without it a measurement that reads the same
	// number twice — a stubbed `/proc`, a pid that is not the agent's, a
	// budget nothing could exceed — would pass the case above for the wrong
	// reason. The old whole-file path on the SAME file through the SAME
	// measurement must blow the same budget.
	it('is measurably cheaper than the whole-file reply it replaces', async () => {
		writeLargeFile('measured.bin', MEMORY_CASE_BYTES)
		const { port, pid } = await startChildAgent()
		const before = await peakResidentBytes(pid)

		const reply = await sendFramedRequest(
			port,
			{ op: 'read-file', token: POD_UID, body: { path: 'measured.bin', encoding: 'base64' } },
			120_000,
		)
		expect(reply.reply.ok).toBe(true)

		const growth = (await peakResidentBytes(pid)) - before
		expect(growth).toBeGreaterThan(STREAM_MEMORY_BUDGET_BYTES)
	}, 120_000)

	// The risk a multi-frame reply introduces that a single reply never had:
	// a guest that writes as fast as it can reads the whole file into its
	// own socket write queue when the consumer is slow, which is the cost
	// this op exists to avoid, arriving by a different route. So the guest
	// waits for each `data` frame to drain and the host pauses the socket
	// once its own queue is full. Measured MID-stream, while the consumer is
	// deliberately holding: if either half were missing, the rest of the
	// file would already be in the guest by now.
	it('does not read ahead into its own heap while the consumer holds', async () => {
		writeLargeFile('slow.bin', SLOW_CONSUMER_BYTES)
		const { port, pid } = await startChildAgent({
			NAMZU_AGENT_READ_FILE_STREAM_CHUNK_BYTES: String(64 * 1024),
		})
		const before = await peakResidentBytes(pid)

		let growthWhileHolding = Number.NaN
		for await (const _chunk of transportFor(port).readFileStream('slow.bin')) {
			// Long enough that an unbounded guest would have finished the
			// file — the whole 128 MiB crosses loopback in well under this.
			await new Promise((resolve) => setTimeout(resolve, 1_500))
			growthWhileHolding = (await peakResidentBytes(pid)) - before
			break
		}

		expect(growthWhileHolding).toBeLessThan(STREAM_MEMORY_BUDGET_BYTES)
	}, 120_000)

	it('gives every descriptor back when the caller aborts mid-stream', async () => {
		writeLargeFile('aborted.bin', MEMORY_CASE_BYTES)
		const { port, pid } = await startChildAgent({
			NAMZU_AGENT_READ_FILE_STREAM_CHUNK_BYTES: String(64 * 1024),
		})
		const baseline = openDescriptorCount(pid)

		const controller = new AbortController()
		let taken = 0
		await expect(async () => {
			for await (const chunk of transportFor(port).readFileStream('aborted.bin', {
				signal: controller.signal,
			})) {
				taken += chunk.length
				if (taken > 256 * 1024) controller.abort(new Error('caller stopped reading'))
			}
		}).rejects.toThrow(/caller stopped reading/)

		// The abort is what the caller sees; the descriptor is what the
		// guest owes back. Poll rather than sleep once: the close follows
		// the socket teardown, which is one event loop turn away, not zero.
		let descriptors = openDescriptorCount(pid)
		for (let attempt = 0; attempt < 100 && descriptors > baseline; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 50))
			descriptors = openDescriptorCount(pid)
		}
		expect(descriptors).toBe(baseline)
	}, 120_000)

	// Leaving the loop is not an abort, and it must release just as much:
	// a `break` is what a caller that has seen enough actually writes.
	it('gives every descriptor back when the caller simply stops iterating', async () => {
		writeLargeFile('abandoned.bin', MEMORY_CASE_BYTES)
		const { port, pid } = await startChildAgent({
			NAMZU_AGENT_READ_FILE_STREAM_CHUNK_BYTES: String(64 * 1024),
		})
		const baseline = openDescriptorCount(pid)

		for await (const _chunk of transportFor(port).readFileStream('abandoned.bin')) {
			break
		}

		let descriptors = openDescriptorCount(pid)
		for (let attempt = 0; attempt < 100 && descriptors > baseline; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 50))
			descriptors = openDescriptorCount(pid)
		}
		expect(descriptors).toBe(baseline)
	}, 120_000)
})

/**
 * The window between the request arriving and the guest's `fs.open`
 * resolving.
 *
 * It is the one place a descriptor can outlive the connection that asked
 * for it: `onClose` marks the handler settled and releases whatever it is
 * holding, and at that instant it is holding nothing — the open has not
 * answered yet. Everything the handler does afterwards is an early
 * `return` that no longer reaches the code which writes the terminator
 * and closes the fd, so the descriptor the open is about to hand back has
 * no owner unless the handler's own `finally` is that owner.
 *
 * Both cases here are paired with a POSITIVE CONTROL: the same race, run
 * against a copy of the shipped agent with that `finally` textually
 * removed. The control asserts the leak, so a case that has stopped being
 * able to see one fails rather than passing for the wrong reason, and the
 * patch it applies is asserted to have matched before either agent runs.
 */
describe.skipIf(IS_WINDOWS || !IS_LINUX)('a peer that hangs up before the open resolves', () => {
	/**
	 * The shipped agent with its descriptor ownership removed, written to
	 * `workDir` so `afterEach` takes it away with everything else.
	 *
	 * Removing the `finally` alone would leave the guard that returns as
	 * soon as the open lands, which closes nothing on its own but would
	 * make the control exit before `stat` — so both come out, which is
	 * exactly the code this commit adds. The agent requires nothing but
	 * `node:` builtins, so a copy runs anywhere the original does.
	 */
	function writeAgentWithoutDescriptorOwnership(): string {
		const shipped = readFileSync(AGENT_ENTRY_FILE, 'utf8')
		// Four edits, two concepts. The first three make the handler stop
		// owning the descriptor it opens: the guard goes too — on its own it
		// closes nothing, but it would make the control return before `stat`
		// and so never reach the shape the defect had.
		//
		// The fourth is not about the defect — it is about OBSERVING it
		// deterministically. `fs.promises` closes an abandoned `FileHandle`
		// the moment it notices one has been garbage collected (Node's own
		// DEP0137 safety net), and that race is not hypothetical: forcing GC
		// in the child agent reproduces an empty descriptor list here every
		// time, the same failure this control saw on CI. Once nothing but a
		// local variable holds the handle, whether the leak is still
		// observable by the time this file gets around to checking depends
		// on whether V8 happened to collect in between — which is exactly
		// the nondeterminism a POSITIVE CONTROL must not have. Stashing the
		// handle somewhere that stays reachable for the rest of the process
		// keeps the leak waiting for the test rather than for V8.
		//
		// Each anchor is asserted to occur exactly once before anything
		// runs, so a rename that makes this patch a no-op fails here rather
		// than turning the control green for free.
		const edits: readonly (readonly [string, string])[] = [
			['\tvoid (async () => {\n\t\ttry {\n', '\tvoid (async () => {\n'],
			[
				`\t\t\tfinish({ type: 'end', bytesSent: sent })\n\t\t} finally {`,
				`\t\t\tfinish({ type: 'end', bytesSent: sent })\n\t\tif (false) {`,
			],
			[
				'\t\t\tif (settled) return\n\t\t\tconst stat = await handle.stat()',
				'\t\t\tconst stat = await handle.stat()',
			],
			[
				"\t\t\thandle = await fs.open(real, 'r')\n",
				"\t\t\thandle = await fs.open(real, 'r')\n" +
					'\t\t\tglobalThis.__namzuLeakedReadFileStreamHandles =\n' +
					'\t\t\t\tglobalThis.__namzuLeakedReadFileStreamHandles || []\n' +
					'\t\t\tglobalThis.__namzuLeakedReadFileStreamHandles.push(handle)\n',
			],
		]
		let broken = shipped
		for (const [anchor, replacement] of edits) {
			expect(broken.split(anchor)).toHaveLength(2)
			broken = broken.replace(anchor, replacement)
		}
		const path = join(workDir, 'agent-without-descriptor-ownership.cjs')
		writeFileSync(path, broken)
		return path
	}

	/** Every descriptor of `pid` that points at `path`, by fd number. */
	function descriptorsPointingAt(pid: number, path: string): string[] {
		return readdirSync(`/proc/${pid}/fd`).filter((fd) => {
			try {
				return readlinkSync(`/proc/${pid}/fd/${fd}`) === path
			} catch {
				// A descriptor closed between the listing and the readlink.
				return false
			}
		})
	}

	/**
	 * Ask `port` to stream the fifo, hang up in the same tick, and only
	 * then open the write end — which is what lets the guest's `fs.open`
	 * return. `fs.open` on a fifo for reading blocks until a writer
	 * arrives, so THAT half of the race needs no timing at all: the open
	 * stays provably pending for as long as this function wants, because
	 * nothing else in the whole file ever writes to `slow.fifo`.
	 *
	 * The other half is the one a fixed sleep could only guess at: that the
	 * guest's `close` handler — which owns nothing yet, since `fs.open`
	 * has not resolved — has actually RUN before the write end opens and
	 * lets it. A sleep cannot prove that; a full round trip to the SAME
	 * agent can. The hang-up's FIN reaches the kernel before this function
	 * issues a single further syscall, and a fresh connection's own
	 * handshake, request and reply cost the agent's single-threaded event
	 * loop several more turns than replaying an already-queued `close`
	 * callback does — so by the time the round trip's own socket has
	 * closed, the hang-up has been observed.
	 */
	async function raceAnOpenAgainstAHangUp(port: number, fifo: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const socket = connect({ host: '127.0.0.1', port }, () => {
				socket.write(
					encodeFrame(
						JSON.stringify({ op: 'read-file-stream', token: POD_UID, body: { path: 'slow.fifo' } }),
					),
				)
				socket.destroy()
				resolve()
			})
			socket.once('error', reject)
		})
		// A bounded wait on an observable, not a sleep: this resolves only
		// once the agent has accepted a connection, read a frame, replied
		// and closed it — work the event loop cannot run ahead of the
		// hang-up's own `close` callback above.
		await sendFramedRequest(port, { op: 'healthz' })
		const writer = await open(fifo, 'w')
		await writer.close()
	}

	/** Poll until `pid` holds no descriptor for `path`, or give up. */
	async function settleDescriptorsFor(pid: number, path: string): Promise<string[]> {
		let held = descriptorsPointingAt(pid, path)
		for (let attempt = 0; attempt < 100 && held.length > 0; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 50))
			held = descriptorsPointingAt(pid, path)
		}
		return held
	}

	it('closes the descriptor its open was still waiting for', async () => {
		const fifo = join(workDir, 'slow.fifo')
		execFileSync('mkfifo', [fifo])
		const broken = writeAgentWithoutDescriptorOwnership()

		const shippedAgent = await startChildAgent()
		await raceAnOpenAgainstAHangUp(shippedAgent.port, fifo)
		expect(await settleDescriptorsFor(shippedAgent.pid, fifo)).toEqual([])

		// The control. Same race, same fifo, an agent that only lacks the
		// ownership this case exists for — and it keeps the descriptor,
		// which is what makes the assertion above mean something.
		const brokenAgent = await startChildAgent({}, broken)
		await raceAnOpenAgainstAHangUp(brokenAgent.port, fifo)
		expect(await settleDescriptorsFor(brokenAgent.pid, fifo)).toHaveLength(1)
	}, 120_000)

	/**
	 * The same defect without the fifo: an ordinary file, and a host that
	 * hangs up in the tick it asked. One is a race; a burst of them is not,
	 * because a descriptor that outlives its connection never comes back
	 * and the count only climbs.
	 */
	it('gives every descriptor back across a burst of same-tick hang-ups', async () => {
		writeFileSync(join(workDir, 'burst.bin'), deterministicBytes(8 * 1024 * 1024))
		const attempts = 24
		const broken = writeAgentWithoutDescriptorOwnership()

		const hangUpOnce = async (port: number): Promise<void> => {
			await new Promise<void>((resolve, reject) => {
				const socket = connect({ host: '127.0.0.1', port }, () => {
					socket.write(
						encodeFrame(
							JSON.stringify({
								op: 'read-file-stream',
								token: POD_UID,
								body: { path: 'burst.bin' },
							}),
						),
					)
					socket.destroy()
					resolve()
				})
				socket.once('error', reject)
			})
			await new Promise((resolve) => setTimeout(resolve, 5))
		}

		const shippedAgent = await startChildAgent()
		const baseline = openDescriptorCount(shippedAgent.pid)
		for (let attempt = 0; attempt < attempts; attempt += 1) await hangUpOnce(shippedAgent.port)
		let descriptors = openDescriptorCount(shippedAgent.pid)
		for (let attempt = 0; attempt < 100 && descriptors > baseline; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 50))
			descriptors = openDescriptorCount(shippedAgent.pid)
		}
		expect(descriptors).toBe(baseline)

		const brokenAgent = await startChildAgent({}, broken)
		const brokenBaseline = openDescriptorCount(brokenAgent.pid)
		for (let attempt = 0; attempt < attempts; attempt += 1) await hangUpOnce(brokenAgent.port)
		await new Promise((resolve) => setTimeout(resolve, 1_000))
		// Not `attempts` exactly: the control's job is to prove the burst
		// reaches the window at all, and how often it does is scheduling.
		expect(openDescriptorCount(brokenAgent.pid)).toBeGreaterThan(brokenBaseline)
	}, 120_000)
})

describe.skipIf(IS_WINDOWS)('a whole-file readFile is built on the stream', () => {
	// The silent-corruption risk of building one path on another: every
	// size the old path served must come back byte-identical from the new
	// one. Both answers are produced here, from the same file, and compared
	// to each other rather than each to an expectation.
	it.each([0, 1, 4_095, 1_048_576, 9 * 1024 * 1024])(
		'answers a %i-byte file exactly as the single-frame path does',
		async (size) => {
			const { port } = await startAgent()
			const payload = deterministicBytes(size)
			writeFileSync(join(workDir, 'same.bin'), payload)

			const streamed = await transportFor(port).readFile('same.bin')
			const framed = await sendFramedRequest(port, {
				op: 'read-file',
				token: POD_UID,
				body: { path: 'same.bin', encoding: 'base64' },
			})
			const single = Buffer.from(String(framed.reply.content), 'base64')

			expect(streamed.length).toBe(size)
			expect(digest(streamed)).toBe(digest(single))
			expect(digest(streamed)).toBe(digest(payload))
		},
		60_000,
	)

	it('reports a missing file as a rejection, not as an empty stream', async () => {
		const { port } = await startAgent()
		await expect(transportFor(port).readFile('nothing-here.bin')).rejects.toThrow()
	})

	/**
	 * The one file shape whose length cannot be asked for in advance: a
	 * REGULAR file that `stat` reports as zero bytes and that still has
	 * content. `/proc` is where they live, and an operator reaches them by
	 * naming such a root in `NAMZU_SANDBOX_READ_ROOTS`.
	 *
	 * It matters here and nowhere else because a whole-file `readFile` is
	 * now SERVED by the stream, and a stream bounded by `stat.size` would
	 * answer an empty buffer where `fs.readFile` answered the file — the
	 * silent corruption this whole block exists to rule out, on the one
	 * input a size-driven loop cannot see.
	 */
	it.skipIf(!IS_LINUX)('reads a regular file whose stat reports no size at all', async () => {
		// The premise, asserted rather than assumed: if this ever stops
		// being a sizeless file the case proves nothing and should say so.
		expect(statSync('/proc/version').isFile()).toBe(true)
		expect(statSync('/proc/version').size).toBe(0)
		const expected = readFileSync('/proc/version')
		expect(expected.length).toBeGreaterThan(0)

		const { port } = await startAgent({ NAMZU_SANDBOX_READ_ROOTS: '/proc' })
		const streamed = await transportFor(port).readFile('/proc/version')
		expect(streamed.toString('utf8')).toBe(expected.toString('utf8'))

		const chunks: Buffer[] = []
		for await (const chunk of transportFor(port).readFileStream('/proc/version')) {
			chunks.push(Buffer.from(chunk))
		}
		expect(Buffer.concat(chunks).toString('utf8')).toBe(expected.toString('utf8'))
	})

	// Deciding which path a read takes means asking the guest what it can do,
	// and a whole-file read has no size to decide from until the bytes are
	// already crossing — so the question is asked once per transport rather
	// than once per read, and the readiness probe every deployment already
	// makes is what answers it. Without that, the first read of a sandbox's
	// life would open a connection purely to ask.
	it('asks the guest once, and the readiness probe is what pays for it', async () => {
		const { port } = await startAgent()
		writeFileSync(join(workDir, 'counted.bin'), Buffer.from('short enough'))
		let connections = 0
		listener?.on('connection', () => {
			connections += 1
		})
		const transport = transportFor(port)

		expect(await transport.healthz()).toBe(true)
		expect(connections).toBe(1)

		await transport.readFile('counted.bin')
		await transport.readFile('counted.bin')
		// One connection per read and not one more: the readiness probe
		// filled the capability cache, and it is never asked again.
		expect(connections).toBe(3)
	})
})

/**
 * A guest that answers `healthz` the way every agent before this release
 * did — `ok` and a protocol version, and no `features` at all.
 *
 * Such an agent IGNORES `offset`/`length` and answers with the whole file.
 * So the host must never send it either new shape: a ranged read that came
 * back whole would be a wrong answer wearing the shape of a right one.
 */
describe('a guest that does not advertise the capability', () => {
	let server: Server | undefined
	let requests: Record<string, unknown>[] = []
	const body = Buffer.from('the file, whole, exactly as it always was')

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
							: {
									ok: true,
									content: body.toString('base64'),
									sizeBytes: body.length,
									encoding: 'base64',
								}
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

	it('still serves a whole-file read on the unchanged single-frame path', async () => {
		const read = await transport().readFile('whole.bin')

		expect(read.equals(body)).toBe(true)
		// One probe, then the read it has always sent — with no offset and
		// no length anywhere on the wire.
		expect(requests.map((request) => request.op)).toEqual(['healthz', 'read-file'])
		const sent = requests[1]?.body as Record<string, unknown>
		expect(sent.offset).toBeUndefined()
		expect(sent.length).toBeUndefined()
	})

	it('refuses a ranged read with the named error, having sent no range', async () => {
		let caught: unknown
		try {
			await transport().readFile('whole.bin', { offset: 4, length: 8 })
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(AgentReadFileStreamUnsupportedError)
		expect((caught as Error).message).toContain(READ_FILE_STREAM_FEATURE)
		// It asked, it was not told yes, and it stopped.
		expect(requests.map((request) => request.op)).toEqual(['healthz'])
	})

	it('refuses a stream with the named error, having dialed nothing but the probe', async () => {
		let caught: unknown
		try {
			for await (const _chunk of transport().readFileStream('whole.bin')) {
				// never reached
			}
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(AgentReadFileStreamUnsupportedError)
		expect((caught as Error).message).toContain(READ_FILE_STREAM_FEATURE)
		expect(requests.map((request) => request.op)).toEqual(['healthz'])
	})
})

describe.skipIf(IS_WINDOWS || !RUN_GIANT)('the acceptance sizes', () => {
	it('streams a 1 GiB file whose digest matches the guest’s own sha256sum', async () => {
		const { port } = await startAgent()
		const transport = transportFor(port)
		const created = await transport.exec('sh', [
			'-c',
			`head -c ${GIANT_STREAM_BYTES} /dev/urandom > giant.bin && sha256sum giant.bin`,
		])
		expect(created.exitCode).toBe(0)
		const guestDigest = created.stdout.trim().split(/\s+/)[0]

		const hash = createHash('sha256')
		let bytes = 0
		for await (const chunk of transport.readFileStream('giant.bin')) {
			hash.update(chunk)
			bytes += chunk.length
		}

		expect(bytes).toBe(GIANT_STREAM_BYTES)
		expect(hash.digest('hex')).toBe(guestDigest)
	}, 1_200_000)

	// The size the old path could not reach on the guest without exceeding
	// the shipped template's memory limit, read through the ordinary
	// whole-file method with no code change at the call site.
	it('reads a 256 MiB file through plain readFile, inside twice its size on the host', async () => {
		const expected = writeLargeFile('big.bin', GIANT_WHOLE_BYTES)
		const { port } = await startAgent()
		const before = process.memoryUsage().rss

		const read = await transportFor(port).readFile('big.bin')

		expect(read.length).toBe(GIANT_WHOLE_BYTES)
		expect(digest(read)).toBe(expected)
		expect(process.memoryUsage().rss - before).toBeLessThan(2 * GIANT_WHOLE_BYTES)
	}, 1_200_000)
})
