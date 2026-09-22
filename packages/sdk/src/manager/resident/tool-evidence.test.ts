import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import type { SessionEvidenceSource } from '../../store/evidence/types.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTurnId,
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
	const turnScope = {
		tenantId,
		projectId,
		sessionId: generateSessionId(),
		turnId: generateTurnId(),
	}
	const search = vi.fn().mockResolvedValue({
		scope: turnScope,
		matches: [],
		nextCursor: null,
		scannedBytes: 0,
		indexedRecords: 0,
		cacheHit: false,
		incomplete: false,
		unavailable: [],
	})
	const backend: SessionEvidenceSource = { scope: turnScope, search, read: vi.fn() }
	const resolveTurn = vi.fn().mockResolvedValue(backend)
	const unresolved = createResidentToolEvidenceSource({
		history: agenda.history(claim, (await agenda.read())!.revision),
		projectId,
		resolveTurn,
	})
	expect((await unresolved.search()).evidence).toBeNull()
	expect(resolveTurn).not.toHaveBeenCalled()
	const settled = await execution.settle(
		claim,
		{ kind: 'wait', wakeAt: null, summary: 'First observation.' },
		2,
	)
	const boundary = (await agenda.read())!.revision
	const source = createResidentToolEvidenceSource({
		history: agenda.history(settled, boundary),
		projectId,
		resolveTurn,
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
	expect(resolveTurn).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ claimId: claim.claimId }),
		undefined,
	)
	await expect(
		source.read({ revision: (await agenda.read())!.revision, address: 'anything' }),
	).rejects.toThrow()
	expect(resolveTurn).toHaveBeenCalledTimes(1)
	resolveTurn.mockResolvedValue({
		...backend,
		scope: { ...turnScope, projectId: generateProjectId() },
	})
	const refused = await source.search()
	expect(refused.evidence).toBeNull()
	expect(refused.incomplete).toBe(true)
	expect(search).toHaveBeenCalledTimes(1)
	const aborted = AbortSignal.abort(new Error('cancelled'))
	await expect(source.search({}, aborted)).rejects.toThrow('cancelled')
})

it('refuses a resolved source that spans a whole session instead of naming its turn', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-tool-history-turn-'))
	roots.push(root)
	const tenantId = generateTenantId()
	const projectId = generateProjectId()
	const agenda = new DiskResidentAgenda(root, { tenantId, agentKey: 'owner' })
	const pursuit = await agenda.add(await agenda.create('Observe receipts.'), 'Own objective.')
	const execution = agenda.execution(pursuit.id)
	const settled = await execution.settle(
		await execution.claim(pursuit.state, 1),
		{ kind: 'wait', wakeAt: null, summary: 'First observation.' },
		2,
	)
	// No turnId: a session-wide source could answer with another turn's records.
	const sessionScope = { tenantId, projectId, sessionId: generateSessionId() }
	const search = vi.fn()
	const source = createResidentToolEvidenceSource({
		history: agenda.history(settled, (await agenda.read())!.revision),
		projectId,
		resolveTurn: vi.fn().mockResolvedValue({ scope: sessionScope, search, read: vi.fn() }),
	})
	const page = await source.search({ query: 'value' })
	expect(page.evidence).toBeNull()
	expect(page.incomplete).toBe(true)
	expect(search).not.toHaveBeenCalled()
})
