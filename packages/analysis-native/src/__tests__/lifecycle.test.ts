import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type NativeAnalysis, createNativeAnalysis } from '../client.js'
import { SIDECAR_ENV, platformPackageName, resolveSidecar } from '../resolve.js'

/**
 * The client's process handling, against a stand-in sidecar written in Node.
 * No Rust binary is needed, so this suite runs wherever the tests do. The
 * stand-in does what each request's params tell it to, so no outcome depends
 * on timing: the deadline test advances a fake clock and the child's reaction
 * is an event, not a wait.
 */

const dir = mkdtempSync(join(tmpdir(), 'analysis-native-life-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const script = join(dir, 'fake-sidecar.cjs')
beforeAll(() => {
	writeFileSync(
		script,
		`
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const req = JSON.parse(buf.slice(0, nl))
    buf = buf.slice(nl + 1)
    const p = req.params || {}
    if (p.hang) continue
    if (p.crash) { console.error('boom: the fake sidecar crashed'); process.exit(3) }
    if (p.huge) { process.stdout.write('x'.repeat(p.huge)); continue }
    if (p.nullid) { process.stdout.write(JSON.stringify({ id: null, ok: false, error: { code: 'request_too_large', message: 'request line is over 1 bytes' } }) + '\\n'); continue }
    if (p.garbage) { process.stdout.write('not json\\n'); continue }
    if (p.error) { process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: { code: 'file_error', message: 'nope' } }) + '\\n'); continue }
    process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { op: req.op, pid: process.pid, deadlineMs: req.deadlineMs, maxBytes: req.maxBytes, params: p } }) + '\\n')
  }
})
`,
	)
})

let client: NativeAnalysis | undefined
function make(options: Parameters<typeof createNativeAnalysis>[0] = {}): NativeAnalysis {
	client = createNativeAnalysis({ binaryPath: process.execPath, args: [script], ...options })
	return client
}
afterEach(async () => {
	vi.useRealTimers()
	await client?.close()
	client = undefined
})

interface Echo {
	op: string
	pid: number
	deadlineMs: number
	maxBytes: number
	params: Record<string, unknown>
}

describe('NativeAnalysis process handling', () => {
	it('sends the deadline and output cap with every request', async () => {
		const c = make({ deadlineMs: 1234, maxOutputBytes: 99_999 })
		const r = await c.request<Echo>('ping', { a: 1 })
		expect(r).toMatchObject({ op: 'ping', deadlineMs: 1234, maxBytes: 99_999, params: { a: 1 } })
		const over = await c.request<Echo>('ping', {}, { deadlineMs: 5, maxBytes: 2048 })
		expect(over).toMatchObject({ deadlineMs: 5, maxBytes: 2048 })
	})

	it('resolves relative paths against the caller', async () => {
		const c = make()
		const r = await c.request<Echo>('ping', { path: 'some/file', outDir: 'out' })
		expect(r.params.path).toBe(join(process.cwd(), 'some/file'))
		expect(r.params.outDir).toBe(join(process.cwd(), 'out'))
	})

	it('kills a process that outlives its deadline and starts a new one', async () => {
		const c = make({ killGraceMs: 500 })
		const before = await c.request<Echo>('ping')
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		const hung = c.request('ping', { hang: true }, { deadlineMs: 1000 })
		const rejected = expect(hung).rejects.toMatchObject({ code: 'deadline_exceeded', op: 'ping' })
		// Before the deadline plus grace the request is still pending.
		await vi.advanceTimersByTimeAsync(1499)
		await vi.advanceTimersByTimeAsync(1)
		await rejected
		vi.useRealTimers()
		const after = await c.request<Echo>('ping')
		expect(after.pid).not.toBe(before.pid)
	})

	it('fails only the request in flight when the process crashes', async () => {
		const diagnostics: string[] = []
		const c = make({ onDiagnostic: (l) => diagnostics.push(l) })
		const first = await c.request<Echo>('ping')
		const crashed = c.request('ping', { crash: true })
		const queued = c.request<Echo>('ping', { n: 2 })
		await expect(crashed).rejects.toMatchObject({
			code: 'sidecar_exited',
			message: expect.stringContaining('boom'),
		})
		const second = await queued
		expect(second.pid).not.toBe(first.pid)
		expect(diagnostics.join('\n')).toContain('boom')
	})

	it('stops a process whose response passes the output cap', async () => {
		const c = make({ maxOutputBytes: 4096 })
		const before = await c.request<Echo>('ping')
		await expect(c.request('ping', { huge: 1 << 20 })).rejects.toMatchObject({
			code: 'response_too_large',
		})
		expect((await c.request<Echo>('ping')).pid).not.toBe(before.pid)
	})

	it('treats a line that is not JSON as a protocol error and replaces the process', async () => {
		const c = make()
		const before = await c.request<Echo>('ping')
		await expect(c.request('ping', { garbage: true })).rejects.toMatchObject({
			code: 'protocol_error',
		})
		expect((await c.request<Echo>('ping')).pid).not.toBe(before.pid)
	})

	it('rejects the request in flight when the sidecar answers with a null id', async () => {
		const c = make()
		const first = await c.request<Echo>('ping')
		// No fake timers and no race: the rejection arrives as soon as the frame
		// does, or the test's own timeout reports the hang.
		await expect(c.request('ping', { nullid: true })).rejects.toMatchObject({
			code: 'request_too_large',
			op: 'ping',
		})
		// An error frame is not a crash: the same process serves the next request.
		expect((await c.request<Echo>('ping')).pid).toBe(first.pid)
	})

	it('refuses a request over the sidecar request limit without sending it', async () => {
		const c = make({ args: [script, '--max-request-bytes', '2048'] })
		const first = await c.request<Echo>('ping')
		await expect(c.request('ping', { blob: 'x'.repeat(4096) })).rejects.toMatchObject({
			code: 'request_too_large',
			op: 'ping',
		})
		expect((await c.request<Echo>('ping')).pid).toBe(first.pid)
	})

	it('maps an error response to NativeAnalysisError with the sidecar code', async () => {
		const c = make()
		await expect(c.request('ping', { error: true })).rejects.toMatchObject({
			code: 'file_error',
			message: 'nope',
		})
		// Same process afterwards: an error response is not a crash.
		const a = await c.request<Echo>('ping')
		const b = await c.request<Echo>('ping')
		expect(a.pid).toBe(b.pid)
	})

	it('fails queued and later requests after close', async () => {
		const c = make()
		await c.request('ping')
		const hung = c.request('ping', { hang: true })
		const queued = c.request('ping')
		const closing = c.close()
		await expect(hung).rejects.toMatchObject({ code: 'closed' })
		await expect(queued).rejects.toMatchObject({ code: 'closed' })
		await closing
		await expect(c.request('ping')).rejects.toMatchObject({ code: 'closed' })
		await c.close()
	})

	it('names the missing binary', () => {
		expect(() => createNativeAnalysis({ binaryPath: join(dir, 'nope') })).toThrow(
			expect.objectContaining({ code: 'sidecar_not_found' }),
		)
	})
})

describe('resolveSidecar', () => {
	const touch = (path: string) => {
		mkdirSync(join(path, '..'), { recursive: true })
		writeFileSync(path, '')
		return path
	}

	it('prefers an explicit path, then the environment, then the platform package, then target/', () => {
		const root = join(dir, 'resolve')
		const explicit = touch(join(root, 'explicit'))
		const fromEnv = touch(join(root, 'env'))
		const pkgManifest = touch(join(root, 'pkg', 'package.json'))
		const pkgBin = touch(join(root, 'pkg', 'bin', 'namzu-analysis-native'))
		const dev = touch(join(root, 'dev', 'target', 'release', 'namzu-analysis-native'))
		const resolvePackage = (s: string) => {
			expect(s).toBe(`${platformPackageName('linux', 'x64')}/package.json`)
			return pkgManifest
		}
		const base = { platform: 'linux', arch: 'x64', resolvePackage, packageRoot: join(root, 'dev') }
		expect(
			resolveSidecar({ ...base, binaryPath: explicit, env: { [SIDECAR_ENV]: fromEnv } }),
		).toEqual({
			path: explicit,
			source: 'option',
		})
		expect(resolveSidecar({ ...base, env: { [SIDECAR_ENV]: fromEnv } })).toEqual({
			path: fromEnv,
			source: 'env',
		})
		expect(resolveSidecar({ ...base, env: {} })).toEqual({
			path: pkgBin,
			source: 'platform-package',
		})
		expect(
			resolveSidecar({
				...base,
				env: {},
				resolvePackage: () => {
					throw new Error('not installed')
				},
			}),
		).toEqual({ path: dev, source: 'development' })
	})

	it('does not fall through when an explicit path or variable names a missing file', () => {
		const base = { platform: 'linux', arch: 'x64', packageRoot: dir }
		expect(resolveSidecar({ ...base, binaryPath: join(dir, 'gone'), env: {} })).toBeNull()
		expect(resolveSidecar({ ...base, env: { [SIDECAR_ENV]: join(dir, 'gone') } })).toBeNull()
	})

	it('finds nothing in an empty checkout', () => {
		expect(
			resolveSidecar({
				env: {},
				packageRoot: join(dir, 'empty'),
				resolvePackage: () => {
					throw new Error('not installed')
				},
			}),
		).toBeNull()
	})

	it('uses .exe on Windows', () => {
		const root = join(dir, 'win')
		const manifest = touch(join(root, 'pkg', 'package.json'))
		const exe = touch(join(root, 'pkg', 'bin', 'namzu-analysis-native.exe'))
		expect(
			resolveSidecar({ env: {}, platform: 'win32', arch: 'x64', resolvePackage: () => manifest }),
		).toEqual({ path: exe, source: 'platform-package' })
	})
})
