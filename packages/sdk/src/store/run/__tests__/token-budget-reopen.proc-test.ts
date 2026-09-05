import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'
import type { TokenBudgetScope } from '../../../types/run/token-budget-store.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
} from '../../../utils/id.js'

const execute = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, '..', '..', '..', '..', 'dist')
const worker = join(here, 'token-budget-worker.mjs')
let baseDir: string
let scope: TokenBudgetScope

beforeEach(async () => {
	baseDir = await mkdtemp(join(tmpdir(), 'namzu-ledger-process-'))
	scope = {
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		runId: generateRunId(),
	}
})

afterEach(async () => {
	await removeTempDirAsync(baseDir)
})

async function run(mode: string, correlation?: { accountId: string; requestId: string }) {
	const { stdout } = await execute(
		process.execPath,
		[worker, dist, baseDir, JSON.stringify(scope), mode, JSON.stringify(correlation ?? {})],
		{ timeout: 10_000 },
	)
	return JSON.parse(stdout.trim())
}

describe('only a durable receipt returns a child grant after process exit', () => {
	it('settles measured child usage once in a new process', async () => {
		const correlation = await run('seed-completed')
		const first = await run('settle-completed', correlation)
		expect(first).toMatchObject({
			ownTokens: 100,
			treeTokens: 250,
			reservedTokens: 0,
			remainingTokens: 750,
			poisoned: false,
		})
		const repeated = await run('settle-completed', correlation)
		expect(repeated).toEqual(first)
	})

	it('retains an unmeasured call and refuses new admission after the original process exited', async () => {
		const correlation = await run('seed-unresolved')
		const reopened = await run('inspect-unresolved', correlation)
		expect(reopened.admitted).toBe(false)
		expect(reopened.summary).toMatchObject({
			ownTokens: 100,
			remainingTokens: 0,
			inFlightRequests: 1,
			unsettledChildren: 1,
			poisoned: true,
		})
		expect(reopened.snapshot.requests).toEqual([
			expect.objectContaining({ id: correlation.requestId, accountId: correlation.accountId }),
		])
		expect(
			reopened.snapshot.accounts.find(
				(account: { id: string }) => account.id === correlation.accountId,
			),
		).toMatchObject({ limit: 400, settled: false })
	})
})
