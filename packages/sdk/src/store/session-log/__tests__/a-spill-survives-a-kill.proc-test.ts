import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { generateSessionId } from '../../../utils/id.js'
import { DiskSessionLog, readSessionLog } from '../disk.js'
import { DiskSpillStore } from '../spill.js'

/**
 * A process killed while appending spilled records never leaves a record
 * without its spill, and the next writer repairs whatever tail the kill cut.
 *
 * Each round starts a writer that appends messages too large for a record
 * (so every one spills first) as fast as it can, and SIGKILLs it at a varying
 * moment. The next round's writer takes the lease, which repairs a torn tail,
 * closes the dead writer's turn and carries on. At the end every record that
 * names a spill must find its body and manifest on disk, hashing to what the
 * record says.
 *
 * A SIGKILL keeps the page cache, so this proves the ORDER (spill published
 * before the record is written), not durability across a power loss; the
 * fsyncs that give the latter cannot be observed from a test.
 */

const DIST = join(import.meta.dirname, '../../../../dist/store/session-log/index.js')
const IDS = join(import.meta.dirname, '../../../../dist/utils/id.js')

const made: string[] = []
afterEach(async () => {
	await removeTempDirs(made.splice(0))
})

function writer(root: string, sessionId: string, round: number): Promise<void> {
	const script = `
		const { writeFileSync } = await import('node:fs')
		const { DiskSessionLog } = await import(${JSON.stringify(DIST)})
		const { generateProjectId, generateTurnId, generateMessageId } = await import(${JSON.stringify(IDS)})
		const root = ${JSON.stringify(root)}
		const sessionId = ${JSON.stringify(sessionId)}
		const log = new DiskSessionLog({ sessionId, file: root + '/' + sessionId + '.jsonl', sessionDir: root + '/' + sessionId, spillAboveBytes: 2048 })
		const lease = await log.claim({ holder: 'round-${round}:' + process.pid, ttlMs: 50 })
		if ((await log.head()) === null) {
			await log.append(lease, { type: 'session_started', projectId: generateProjectId(), cwd: '/w', agent: { id: 'a', name: 'A' } })
		}
		const turnId = generateTurnId()
		await log.beginTurn(lease, { turnId, userMessageId: generateMessageId(), config: { model: 'm', tokenBudget: 1, timeoutMs: 1 } }, { abandonInterrupted: true })
		writeFileSync(root + '/.ready-${round}', '')
		for (let i = 0; ; i++) {
			await log.append(lease, {
				type: 'message', turnId, messageId: generateMessageId(), role: 'tool',
				content: { role: 'tool', content: 'r${round}-' + i + '-' + 'z'.repeat(4000 + (i % 97)), toolCallId: 'toolu_r${round}_' + i },
			})
		}
	`
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
			stdio: ['ignore', 'ignore', 'pipe'],
		})
		let err = ''
		child.stderr.on('data', (chunk) => {
			err += chunk
		})
		child.on('error', reject)
		const ready = join(root, `.ready-${round}`)
		const poll = setInterval(() => {
			if (!existsSync(ready)) return
			clearInterval(poll)
			// Let it append for a while, then kill it mid-flight.
			setTimeout(() => child.kill('SIGKILL'), 40 + ((round * 37) % 120))
		}, 2)
		child.on('exit', (_code, signal) => {
			clearInterval(poll)
			if (signal === 'SIGKILL') resolve()
			else reject(new Error(`writer ${round} exited without being killed: ${err}`))
		})
	})
}

describe('a spill and a kill', () => {
	it('never leaves a record without its spill, and the log stays one chain', async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-spill-kill-')))
		made.push(root)
		const sessionId = generateSessionId()
		for (let round = 0; round < 6; round++) {
			await writer(root, sessionId, round)
			// Past the dead writer's 50 ms lease.
			await new Promise((r) => setTimeout(r, 80))
		}
		const file = join(root, `${sessionId}.jsonl`)
		const sessionDir = join(root, sessionId)
		// The last kill may have torn the tail; a writer taking the lease repairs it.
		const final = new DiskSessionLog({ sessionId, file, sessionDir })
		expect(await final.claim({ holder: 'final', ttlMs: 1000 })).not.toBe(null)
		const read = await readSessionLog(file, { sessionId })
		expect(read.intact).toBe(true)
		expect(read.tornBytes).toBe(0)
		const spills = new DiskSpillStore(sessionDir)
		let spilled = 0
		for (const { record } of read.entries) {
			if (record.type !== 'message' || record.spill === undefined) continue
			spilled += 1
			expect(existsSync(join(sessionDir, record.spill.manifest))).toBe(true)
			const body = JSON.parse(await spills.read(record.spill)) as { content: string }
			expect(body.content.startsWith('r')).toBe(true)
		}
		expect(spilled).toBeGreaterThan(6)
		// Every dead writer's turn was closed as interrupted before the next began.
		const interrupted = read.entries.filter(
			(e) =>
				e.record.type === 'turn_failed' &&
				(e.record as { failure?: { code: string } }).failure?.code === 'interrupted',
		)
		expect(interrupted).toHaveLength(5)
	})
})
