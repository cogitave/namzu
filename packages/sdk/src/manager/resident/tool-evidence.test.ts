import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import type { RunEvidenceSource } from '../../store/evidence/types.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
} from '../../utils/id.js'
import { DiskResidentAgenda } from './agenda.js'
import { createResidentToolEvidenceSource } from './tool-evidence.js'

const roots: string[] = []
afterEach(async () => {
	await removeTempDirs(roots.splice(0))
})

it('authorizes only settled claims before the admission boundary and refuses a foreign backend', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-tool-history-scope-'))
	roots.push(root)
	const tenantId = generateTenantId()
	const projectId = generateProjectId()
	const agenda = new DiskResidentAgenda(root, { tenantId, agentKey: 'owner' })
	const pursuit = await agenda.add(await agenda.create('Observe receipts.'), 'Own objective.')
	const execution = agenda.execution(pursuit.id)
	const claim = await execution.claim(pursuit.state, 1)
	const runScope = { tenantId, projectId, sessionId: generateSessionId(), runId: generateRunId() }
	const search = vi.fn().mockResolvedValue({
		scope: runScope,
		matches: [],
		nextCursor: null,
		scannedBytes: 0,
		indexedRecords: 0,
		cacheHit: false,
		incomplete: false,
		unavailable: [],
	})
	const backend: RunEvidenceSource = { scope: runScope, search, read: vi.fn() }
	const resolveRun = vi.fn().mockResolvedValue(backend)
	const unresolved = createResidentToolEvidenceSource({
		history: agenda.history(claim, (await agenda.read())!.revision),
		projectId,
		resolveRun,
	})
	expect((await unresolved.search()).evidence).toBeNull()
	expect(resolveRun).not.toHaveBeenCalled()
	const settled = await execution.settle(
		claim,
		{ kind: 'wait', wakeAt: null, summary: 'First observation.' },
		2,
	)
	const boundary = (await agenda.read())!.revision
	const source = createResidentToolEvidenceSource({
		history: agenda.history(settled, boundary),
		projectId,
		resolveRun,
	})
	const other = await agenda.add((await agenda.read())!, 'Foreign pursuit.')
	const foreign = agenda.execution(other.id)
	await foreign.settle(
		await foreign.claim(other.state, 3),
		{ kind: 'complete', summary: 'PRIVATE OTHER.' },
		4,
	)
	const next = await agenda.wake(pursuit.id, settled, 'Later evidence.', 5)
	await execution.settle(
		await execution.claim(next, 6),
		{ kind: 'complete', summary: 'Future observation.' },
		7,
	)
	const page = await source.search({ query: 'value' })
	expect(page.revision).toBe(boundary)
	expect(resolveRun).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ claimId: claim.claimId }),
		undefined,
	)
	await expect(
		source.read({ revision: (await agenda.read())!.revision, address: 'anything' }),
	).rejects.toThrow()
	expect(resolveRun).toHaveBeenCalledTimes(1)
	resolveRun.mockResolvedValue({
		...backend,
		scope: { ...runScope, projectId: generateProjectId() },
	})
	const refused = await source.search()
	expect(refused.evidence).toBeNull()
	expect(refused.incomplete).toBe(true)
	expect(search).toHaveBeenCalledTimes(1)
	const aborted = AbortSignal.abort(new Error('cancelled'))
	await expect(source.search({}, aborted)).rejects.toThrow('cancelled')
})
