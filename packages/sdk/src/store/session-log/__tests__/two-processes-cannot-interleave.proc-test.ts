import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { generateSessionId } from '../../../utils/id.js'
import { readSessionLog } from '../disk.js'

/**
 * Two processes writing one session log.
 *
 * In-process concurrency interleaves promises on one event loop and cannot
 * show what happens between processes, which is where it matters: two
 * terminals, or a drain and a CLI, opening the same session. These spawn
 * real `node` processes against the built module.
 */

const DIST = join(import.meta.dirname, '../../../../dist/store/session-log/index.js')
const IDS = join(import.meta.dirname, '../../../../dist/utils/id.js')

const made: string[] = []
afterEach(async () => {
	await removeTempDirs(made.splice(0))
})

async function scratch(): Promise<string> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'namzu-log-proc-')))
	made.push(dir)
	return dir
}

function run(script: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let out = ''
		let err = ''
		child.stdout.on('data', (chunk) => {
			out += chunk
		})
		child.stderr.on('data', (chunk) => {
			err += chunk
		})
		child.on('error', reject)
		child.on('exit', (code) => {
			if (code === 0) resolve(out)
			else reject(new Error(`child exited ${code}: ${err}`))
		})
	})
}

const prelude = (root: string, sessionId: string) => `
	const { existsSync, writeFileSync } = await import('node:fs')
	const { DiskSessionLog } = await import(${JSON.stringify(DIST)})
	const { generateProjectId } = await import(${JSON.stringify(IDS)})
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
	const waitFor = async (path) => { while (!existsSync(path)) await sleep(2) }
	const root = ${JSON.stringify(root)}
	const sessionId = ${JSON.stringify(sessionId)}
	const open = () => new DiskSessionLog({ sessionId, file: root + '/' + sessionId + '.jsonl', sessionDir: root + '/' + sessionId })
	const started = { type: 'session_started', projectId: generateProjectId(), cwd: '/w', agent: { id: 'a', name: 'A' } }
`

describe('two processes on one session log', () => {
	it('give the lease to one writer; the other is refused, and the log is one unbroken chain', async () => {
		const root = await scratch()
		const sessionId = generateSessionId()
		const gate = join(root, '.go')
		const writer = (name: string) =>
			run(`${prelude(root, sessionId)}
				await waitFor(${JSON.stringify(gate)})
				const log = open()
				const lease = await log.claim({ holder: ${JSON.stringify(name)} + ':' + process.pid, ttlMs: 60000 })
				if (lease === null) { process.stdout.write('refused'); process.exit(0) }
				const head = await log.head()
				if (head === null) await log.append(lease, started)
				for (let i = 0; i < 200; i++) {
					await log.append(lease, { type: 'session_updated', title: ${JSON.stringify(name)} + ' ' + i })
				}
				process.stdout.write('wrote:' + lease.fence)
			`)
		const running = [writer('a'), writer('b')]
		await new Promise((r) => setTimeout(r, 750))
		writeFileSync(gate, '')
		const outcomes = (await Promise.all(running)).sort()
		expect(outcomes).toEqual(['refused', 'wrote:1'])
		const read = await readSessionLog(join(root, `${sessionId}.jsonl`), { sessionId })
		expect(read.intact).toBe(true)
		expect(read.entries).toHaveLength(201)
		expect(read.entries.every((e) => e.record.gen === 1)).toBe(true)
	})

	it('refuse the append of a writer whose lease another process took over', async () => {
		const root = await scratch()
		const sessionId = generateSessionId()
		const aClaimed = join(root, '.a-claimed')
		const bDone = join(root, '.b-done')
		const stale = run(`${prelude(root, sessionId)}
			const log = open()
			const lease = await log.claim({ holder: 'a:' + process.pid, ttlMs: 200 })
			await log.append(lease, started)
			writeFileSync(${JSON.stringify(aClaimed)}, '')
			// Stall past the expiry while b takes the session over.
			await waitFor(${JSON.stringify(bDone)})
			try {
				await log.append(lease, { type: 'session_updated', title: 'late' })
				process.stdout.write('accepted')
			} catch (error) {
				process.stdout.write(error.name + ':' + error.currentFence)
			}
		`)
		const successor = run(`${prelude(root, sessionId)}
			await waitFor(${JSON.stringify(aClaimed)})
			await sleep(400)
			const log = open()
			const lease = await log.claim({ holder: 'b:' + process.pid, ttlMs: 60000 })
			if (lease === null) { process.stdout.write('refused'); process.exit(0) }
			for (let i = 0; i < 20; i++) await log.append(lease, { type: 'session_updated', title: 'b ' + i })
			writeFileSync(${JSON.stringify(bDone)}, '')
			process.stdout.write('wrote:' + lease.fence)
		`)
		const [a, b] = await Promise.all([stale, successor])
		expect(b).toBe('wrote:2')
		expect(a).toBe('StaleSessionLeaseError:2')
		const read = await readSessionLog(join(root, `${sessionId}.jsonl`), { sessionId })
		expect(read.intact).toBe(true)
		expect(read.entries.map((e) => e.record.gen)).toEqual([1, ...Array(20).fill(2)])
	})
})
