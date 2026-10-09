import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { generateSessionId, generateTurnId } from '../../utils/id.js'

const WORKER = fileURLToPath(new URL('./token-budget-worker.mjs', import.meta.url))
const run = promisify(execFile)
const homes: string[] = []
afterEach(async () => {
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

async function trial(limit: number) {
	const home = await mkdtemp(join(tmpdir(), 'namzu-502-process-'))
	homes.push(home)
	const session = generateSessionId()
	const turn = generateTurnId()
	const go = async (mode: 'fail' | 'ok') => {
		const { stdout } = await run(process.execPath, [
			WORKER,
			home,
			session,
			turn,
			String(limit),
			mode,
		])
		return JSON.parse(stdout.trim()) as {
			outcome: string
			summary: { unresolvedRequests: number; ownTokens: number }
		}
	}
	return go
}

// Real processes: the first answers 502 and exits; the second reopens the same durable ledger.
it('lets a conversation with no limit ask again after a 502, with the lost request still recorded as unknown', async () => {
	const go = await trial(0)
	expect((await go('fail')).outcome).toContain('502')
	const second = await go('ok')
	expect(second.outcome).toBe('answered')
	expect(second.summary).toMatchObject({ unresolvedRequests: 1, ownTokens: 40 })
}, 60_000)

it('keeps refusing a second request after a 502 when the conversation has a limit', async () => {
	const go = await trial(1_000_000)
	expect((await go('fail')).outcome).toContain('502')
	const second = await go('ok')
	expect(second.outcome).toContain('no available allowance')
	expect(second.summary.unresolvedRequests).toBe(1)
}, 60_000)
