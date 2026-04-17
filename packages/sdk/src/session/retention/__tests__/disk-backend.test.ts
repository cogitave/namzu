import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionMessage } from '../../../store/session/messages.js'
import type { MessageId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { SubSessionId, SummaryId, WorkspaceId } from '../../../types/session/ids.js'
import type { SessionSummaryRef } from '../../summary/ref.js'
import type { WorkspaceRef } from '../../workspace/ref.js'
import type { ArchiveBackendRef } from '../archive-backend-ref.js'
import { DiskArchiveBackend } from '../disk-backend.js'

const tenantA = 'tnt_alpha' as TenantId

function fakeSessionId(): SessionId {
	return 'ses_fake_1' as SessionId
}

function fakeSubSessionId(): SubSessionId {
	return 'sub_fake_1' as SubSessionId
}

function buildMessages(sessionId: SessionId): SessionMessage[] {
	return [
		{
			id: 'msg_1' as MessageId,
			sessionId,
			tenantId: tenantA,
			message: createUserMessage('hello'),
			at: new Date('2026-04-01T00:00:00Z'),
		},
		{
			id: 'msg_2' as MessageId,
			sessionId,
			tenantId: tenantA,
			message: createUserMessage('world'),
			at: new Date('2026-04-01T00:01:00Z'),
		},
	]
}

function buildSummary(sessionId: SessionId): SessionSummaryRef {
	return {
		id: 'sum_disk_archive_1' as SummaryId,
		sessionRef: sessionId,
		tenantId: tenantA,
		outcome: { status: 'succeeded' },
		deliverables: [],
		agentSummary: 'done',
		keyDecisions: [{ at: new Date('2026-04-01T00:00:30Z'), summary: 'decided x' }],
		at: new Date('2026-04-01T00:02:00Z'),
		materializedBy: 'kernel',
	}
}

function buildWorkspace(): WorkspaceRef {
	return {
		id: 'wsp_archive_1' as WorkspaceId,
		meta: {
			backend: 'git-worktree',
			repoRoot: '/repo',
			branch: 'feature/x',
			worktreePath: '/repo/worktrees/x',
		},
		createdAt: new Date('2026-04-01T00:00:00Z'),
	}
}

describe('DiskArchiveBackend', () => {
	let rootDir: string
	let backend: DiskArchiveBackend

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), 'namzu-archive-disk-'))
		backend = new DiskArchiveBackend({ rootDir })
	})

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true })
	})

	it('store + restore round-trip preserves summary, messages, and subsession metadata', async () => {
		const sessionId = fakeSessionId()
		const subSessionId = fakeSubSessionId()
		const messages = buildMessages(sessionId)
		const summaryRef = buildSummary(sessionId)
		const workspace = buildWorkspace()

		const out = await backend.store({
			subSessionId,
			sessionId,
			tenantId: tenantA,
			workspace,
			summaryRef,
			messages,
		})

		expect(out.archiveRef).toMatch(/^arc_/)
		expect(out.archivedAt).toBeInstanceOf(Date)

		const restored = await backend.restore(out.archiveRef)
		expect(restored.subSessionId).toBe(subSessionId)
		expect(restored.sessionId).toBe(sessionId)
		expect(restored.tenantId).toBe(tenantA)
		expect(restored.workspace?.id).toBe(workspace.id)
		expect(restored.summaryRef?.id).toBe(summaryRef.id)
		expect(restored.summaryRef?.at).toBeInstanceOf(Date)
		expect(restored.messages).toHaveLength(2)
		expect(restored.messages[0]?.at).toBeInstanceOf(Date)
	})

	it('archive location is under {rootDir}/archive/{arc_*}/', async () => {
		const out = await backend.store({
			subSessionId: fakeSubSessionId(),
			sessionId: fakeSessionId(),
			tenantId: tenantA,
			messages: [],
		})

		const archivesRoot = join(rootDir, 'archive')
		const entries = await readdir(archivesRoot)
		expect(entries).toContain(out.archiveRef)
	})

	it('writes the archive.json marker last (atomic via tmp-rename; no stray .tmp after)', async () => {
		const out = await backend.store({
			subSessionId: fakeSubSessionId(),
			sessionId: fakeSessionId(),
			tenantId: tenantA,
			messages: buildMessages(fakeSessionId()),
		})

		const dir = join(rootDir, 'archive', out.archiveRef)
		const entries = await readdir(dir)
		expect(entries).toContain('archive.json')
		expect(entries).toContain('subsession.json')
		expect(entries).toContain('messages.jsonl')
		// No lingering .tmp files from the write-tmp-rename sequence.
		expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)

		const marker = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf-8'))
		expect(marker.archiveRef).toBe(out.archiveRef)
	})

	it('restore on missing archive throws ArchiveNotFoundError (reason: missing)', async () => {
		await expect(backend.restore('arc_nonexistent' as ArchiveBackendRef)).rejects.toMatchObject({
			name: 'ArchiveNotFoundError',
			details: { reason: 'missing' },
		})
	})

	it('multiple archives receive unique refs (no collisions)', async () => {
		const refs = new Set<string>()
		for (let i = 0; i < 5; i++) {
			const out = await backend.store({
				subSessionId: fakeSubSessionId(),
				sessionId: fakeSessionId(),
				tenantId: tenantA,
				messages: [],
			})
			refs.add(out.archiveRef)
		}
		expect(refs.size).toBe(5)
	})

	it('store without optional fields (no workspace, no summary, no messages) still round-trips', async () => {
		const out = await backend.store({
			subSessionId: fakeSubSessionId(),
			sessionId: fakeSessionId(),
			tenantId: tenantA,
			messages: [],
		})
		const restored = await backend.restore(out.archiveRef)
		expect(restored.workspace).toBeUndefined()
		expect(restored.summaryRef).toBeUndefined()
		expect(restored.messages).toHaveLength(0)
	})
})
