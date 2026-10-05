import { spawn } from 'node:child_process'
import { mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'

const token = 'private-file-range-fixture'
const fixtures = []
async function worker() {
	const root = await mkdtemp(path.join(tmpdir(), 'namzu-bounded-file-'))
	const entry = path.join(root, 'worker.cjs')
	await writeFile(entry, await readFile(new URL('../server.js', import.meta.url)))
	const child = spawn(process.execPath, [entry], {
		env: {
			...process.env,
			NAMZU_SANDBOX_PORT: '0',
			NAMZU_SANDBOX_BIND: '127.0.0.1',
			NAMZU_SANDBOX_WORKSPACE: root,
			NAMZU_SANDBOX_READ_ROOTS: root,
			NAMZU_SANDBOX_WRITE_ROOTS: root,
			NAMZU_SANDBOX_IDLE_TIMEOUT_MS: '0',
			NAMZU_SANDBOX_NORMAL_EXIT_POLICY: 'strict',
			NAMZU_SANDBOX_TOKEN: token,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const closed = new Promise((resolve) => child.once('close', resolve))
	fixtures.push({ root, child, closed })
	// Readiness is an actual subprocess event; Vitest handles a genuine startup hang.
	const port = await new Promise((resolve, reject) => {
		let output = ''
		child.stdout.on('data', (bytes) => {
			output += bytes.toString()
			const match = /listening on [^:]+:(\d+)/.exec(output)
			if (match) resolve(Number(match[1]))
		})
		child.once('error', reject)
		child.once('close', () => reject(new Error('Worker exited before readiness')))
	})
	const url = `http://127.0.0.1:${port}/read-file`
	return {
		root,
		post: async (body, authenticated = true) => {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(authenticated ? { authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify(body),
			})
			return { status: response.status, body: await response.json() }
		},
	}
}
afterEach(async () => {
	for (const f of fixtures.splice(0)) {
		if (f.child.exitCode === null && f.child.signalCode === null) f.child.kill('SIGTERM')
		await f.closed
		await rm(f.root, { recursive: true, force: true })
	}
})
it('authenticates capability probes and confirms exact ranges without changing whole-file reads', async () => {
	const f = await worker()
	expect((await f.post({ capabilitiesOnly: true }, false)).status).toBe(401)
	expect(await f.post({ capabilitiesOnly: true })).toEqual({
		status: 200,
		body: {
			ok: true,
			readFileRanges: { version: 1, maxBytes: 32 * 1024 * 1024 },
		},
	})
	await writeFile(path.join(f.root, 'image.bin'), Buffer.from([0, 1, 2, 3, 4, 255]))
	for (const [offset, length, expected] of [
		[2, 3, [2, 3, 4]],
		[4, 10, [4, 255]],
		[99, 2, []],
		[1, 0, []],
	]) {
		const r = await f.post({
			path: 'image.bin',
			encoding: 'base64',
			range: { version: 1, offset, length },
		})
		expect(r).toEqual({
			status: 200,
			body: {
				ok: true,
				content: Buffer.from(expected).toString('base64'),
				encoding: 'base64',
				sizeBytes: expected.length,
				range: { version: 1, offset, length },
			},
		})
	}
	const remaining = await f.post({
		path: 'image.bin',
		encoding: 'base64',
		range: { version: 1, offset: 4 },
	})
	expect(remaining.body.range).toEqual({ version: 1, offset: 4, length: null })
	expect(Buffer.from(remaining.body.content, 'base64')).toEqual(Buffer.from([4, 255]))
	const whole = await f.post({ path: 'image.bin', encoding: 'base64' })
	expect(Buffer.from(whole.body.content, 'base64')).toEqual(Buffer.from([0, 1, 2, 3, 4, 255]))
	expect(whole.body.range).toBeUndefined()
})
it.each([
	null,
	[],
	{ version: 2 },
	{ version: 1, offset: -1 },
	{ version: 1, offset: 1.5 },
	{ version: 1, length: -1 },
	{ version: 1, length: 32 * 1024 * 1024 + 1 },
])('refuses invalid range %j without silently reading the entire file', async (range) => {
	const f = await worker()
	await writeFile(path.join(f.root, 'file'), 'small')
	expect((await f.post({ path: 'file', range })).status).toBe(400)
})
it('bounds a large sparse file and refuses unbounded remainders and directories', async () => {
	const f = await worker()
	const file = await open(path.join(f.root, 'large.bin'), 'w')
	await file.truncate(32 * 1024 * 1024 + 1)
	await file.close()
	const bounded = await f.post({
		path: 'large.bin',
		encoding: 'base64',
		range: { version: 1, length: 4 },
	})
	expect(Buffer.from(bounded.body.content, 'base64')).toEqual(Buffer.alloc(4))
	expect((await f.post({ path: 'large.bin', range: { version: 1, offset: 0 } })).status).toBe(400)
	expect((await f.post({ path: '.', range: { version: 1, length: 1 } })).status).toBe(400)
})
it.skipIf(process.platform === 'win32')(
	'refuses a symlink to data outside the admitted read roots',
	async () => {
		const f = await worker()
		const outside = await mkdtemp(path.join(tmpdir(), 'namzu-range-outside-'))
		try {
			await writeFile(path.join(outside, 'private'), 'outside')
			await symlink(path.join(outside, 'private'), path.join(f.root, 'alias'))
			const r = await f.post({
				path: 'alias',
				range: { version: 1, length: 1 },
			})
			expect(r.status).toBe(400)
			expect(r.body.content).toBeUndefined()
		} finally {
			await rm(outside, { recursive: true, force: true })
		}
	},
)
