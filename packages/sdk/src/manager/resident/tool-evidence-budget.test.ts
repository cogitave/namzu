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
const mib = 1024 * 1024
afterEach(async () => removeTempDirs(roots.splice(0)))

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-resident-read-allowance-'))
	roots.push(root)
	const tenantId = generateTenantId()
	const projectId = generateProjectId()
	const agenda = new DiskResidentAgenda(root, { tenantId, agentKey: 'reader' })
	const pursuit = await agenda.add(
		await agenda.create('Inspect original receipts.'),
		'Recover DELTA.',
	)
	const execution = agenda.execution(pursuit.id)
	const claim = await execution.claim(pursuit.state, 1)
	const state = await execution.settle(
		claim,
		{ kind: 'wait', summary: 'Original DELTA observed.', wakeAt: null },
		2,
	)
	const snapshot = await agenda.read()
	if (!snapshot) throw new Error('Missing agenda snapshot.')
	const revision = snapshot.revision
	const originalHistory = agenda.history(state, revision)
	const history = {
		scope: originalHistory.scope,
		search: vi.fn(originalHistory.search),
		read: vi.fn(originalHistory.read),
	}
	const scope = { tenantId, projectId, sessionId: generateSessionId(), runId: generateRunId() }
	const page = {
		scope,
		matches: [],
		nextCursor: null,
		scannedBytes: 123,
		indexedRecords: 0,
		cacheHit: true,
		incomplete: false,
		unavailable: [],
	}
	const search = vi.fn().mockResolvedValue(page)
	const read = vi.fn().mockResolvedValue({
		scope,
		seq: 2,
		toolName: 'read',
		isError: false,
		retained: 'full',
		text: 'DELTA',
		byteOffset: 0,
		nextByteOffset: null,
		totalBytes: 5,
		scannedBytes: 80,
	})
	const backend: RunEvidenceSource = { scope, search, read }
	const resolveRun = vi.fn().mockResolvedValue(backend)
	const options = { history, projectId, resolveRun }
	return { revision, history, backend, search, read, resolveRun, page, options }
}

it('reserves resolution and run capacity before history, then charges all stages to one ceiling', async () => {
	const f = await fixture()
	const limit = 2 * mib
	const resolutionReadBytes = 128 * 1024
	const source = createResidentToolEvidenceSource({ ...f.options, resolutionReadBytes })
	const page = await source.search({ query: 'DELTA', maxReadBytes: limit })
	expect(f.history.search.mock.calls[0]?.[0]).toMatchObject({
		maxReadBytes: limit - resolutionReadBytes - mib,
	})
	expect(f.search.mock.calls[0]?.[0]).toMatchObject({
		maxReadBytes: limit - resolutionReadBytes - page.historyBytes,
	})
	expect(page.chargedBytes).toBe(page.historyBytes + resolutionReadBytes + 123)
	expect(page.chargedBytes).toBeLessThanOrEqual(limit)
	const read = await source.read({ revision: f.revision, address: 'retained', maxReadBytes: limit })
	const historyRead = await f.history.read.mock.results[0]?.value
	if (!historyRead) throw new Error('History authorization was not read.')
	expect(f.read.mock.calls[0]?.[0]).toMatchObject({
		maxReadBytes: limit - resolutionReadBytes - historyRead.scannedBytes,
	})
	expect(read.chargedBytes).toBe(historyRead.scannedBytes + resolutionReadBytes + 80)
})

it('requires a declared resolution ceiling before any bounded retrieval I/O', async () => {
	const f = await fixture()
	const source = createResidentToolEvidenceSource(f.options)
	await expect(source.search({ maxReadBytes: 2 * mib })).rejects.toThrow('resolution')
	await expect(
		source.read({ revision: f.revision, address: 'a', maxReadBytes: 2 * mib }),
	).rejects.toThrow('resolution')
	expect(f.history.search).not.toHaveBeenCalled()
	expect(f.history.read).not.toHaveBeenCalled()
	expect(f.resolveRun).not.toHaveBeenCalled()
	const oldPage = await source.search()
	expect(oldPage.chargedBytes).toBeUndefined()
	expect(f.search.mock.calls[0]?.[0]).not.toHaveProperty('maxReadBytes')
})

it('retains a history cursor when only the reserved archive capacity remains', async () => {
	const f = await fixture()
	const resolutionReadBytes = 128 * 1024
	const source = createResidentToolEvidenceSource({ ...f.options, resolutionReadBytes })
	const page = await source.search({ query: 'DELTA', maxReadBytes: mib + resolutionReadBytes + 1 })
	expect(page).toMatchObject({ evidence: null, chargedBytes: 0, unavailableRevisions: [] })
	if (!page.nextCursor) throw new Error('Missing history continuation.')
	expect(f.resolveRun).not.toHaveBeenCalled()
	const resumed = await source.search({
		query: 'DELTA',
		cursor: page.nextCursor,
		maxReadBytes: 2 * mib,
	})
	expect(resumed.revision).toBe(f.revision)
	expect(resumed.evidence).not.toBeNull()
})

it.each([0, 1.5, Number.NaN, 8 * mib + 1])(
	'rejects invalid shared allowance %s before calling history',
	async (maxReadBytes) => {
		const f = await fixture()
		const source = createResidentToolEvidenceSource({ ...f.options, resolutionReadBytes: 0 })
		await expect(source.search({ maxReadBytes })).rejects.toThrow()
		await expect(
			source.read({ revision: f.revision, address: 'a', maxReadBytes }),
		).rejects.toThrow()
		expect(f.history.search).not.toHaveBeenCalled()
		expect(f.history.read).not.toHaveBeenCalled()
	},
)

it.each(['resolve', 'search'] as const)(
	'charges the remaining allowance when %s fails without a byte receipt',
	async (stage) => {
		const f = await fixture()
		if (stage === 'resolve') f.resolveRun.mockRejectedValue(new Error('unavailable'))
		else f.search.mockRejectedValue(new Error('unavailable'))
		const source = createResidentToolEvidenceSource({ ...f.options, resolutionReadBytes: 100 })
		const page = await source.search({ maxReadBytes: 2 * mib })
		expect(page).toMatchObject({
			evidence: null,
			chargedBytes: 2 * mib,
			incomplete: true,
			unavailableRevisions: [f.revision],
		})
	},
)

it.each(['tenantId', 'projectId', 'sessionId', 'runId'] as const)(
	'rejects a returned page with a different %s before exposing text',
	async (field) => {
		const f = await fixture()
		f.search.mockResolvedValue({
			...f.page,
			scope: { ...f.backend.scope, [field]: generateRunId() },
		})
		f.read.mockResolvedValue({
			scope: { ...f.backend.scope, [field]: generateRunId() },
			scannedBytes: 1,
			text: 'FOREIGN',
		})
		const source = createResidentToolEvidenceSource({ ...f.options, resolutionReadBytes: 0 })
		for (const maxReadBytes of [undefined, 2 * mib]) {
			const page = await source.search({ maxReadBytes })
			expect(page).toMatchObject({ evidence: null, incomplete: true })
			expect(page.chargedBytes).toBe(maxReadBytes)
			await expect(
				source.read({ revision: f.revision, address: 'foreign', maxReadBytes }),
			).rejects.toThrow('owner')
		}
	},
)

it.each(['history', 'source'] as const)(
	'refuses an invalid %s cost instead of accepting a negative remaining budget',
	async (stage) => {
		const f = await fixture()
		if (stage === 'history')
			f.history.search.mockResolvedValue({
				matches: [],
				nextCursor: null,
				scannedRevisions: 1,
				scannedBytes: 3 * mib,
				unavailableRevisions: [],
				incomplete: false,
			})
		else f.search.mockResolvedValue({ ...f.page, scannedBytes: 3 * mib })
		const source = createResidentToolEvidenceSource({ ...f.options, resolutionReadBytes: 0 })
		if (stage === 'history') {
			await expect(source.search({ maxReadBytes: 2 * mib })).rejects.toThrow('budget')
			expect(f.resolveRun).not.toHaveBeenCalled()
		} else
			expect(await source.search({ maxReadBytes: 2 * mib })).toMatchObject({
				evidence: null,
				chargedBytes: 2 * mib,
				incomplete: true,
			})
	},
)

it('rejects late source results after cancellation even when the backend ignores its signal', async () => {
	const f = await fixture()
	const source = createResidentToolEvidenceSource({ ...f.options, resolutionReadBytes: 0 })
	for (const kind of ['search', 'read'] as const) {
		const controller = new AbortController()
		const result =
			kind === 'search' ? f.page : { scope: f.backend.scope, scannedBytes: 1, text: 'LATE' }
		f[kind].mockImplementation(async () => {
			controller.abort(new Error('cancelled read'))
			return result
		})
		const pending =
			kind === 'search'
				? source.search({ maxReadBytes: 2 * mib }, controller.signal)
				: source.read(
						{ revision: f.revision, address: 'a', maxReadBytes: 2 * mib },
						controller.signal,
					)
		await expect(pending).rejects.toThrow('cancelled read')
	}
})
