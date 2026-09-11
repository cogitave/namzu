import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { SessionSummaryRef } from '../../../types/summary/ref.js'
import { generateSummaryId, generateTenantId, generateTopicId } from '../../../utils/id.js'
import { SqliteSessionStore } from '../sqlite.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-sqlite-durable-'))
	roots.push(root)
	const databasePath = join(root, 'sessions.sqlite')
	const store = new SqliteSessionStore({ databasePath })
	const tenant = generateTenantId()
	const project = await store.createProject(
		{ tenantId: tenant, rootPath: root, name: 'workspace' },
		tenant,
	)
	const session = await store.createSession(
		{ projectId: project.id, topicId: generateTopicId(), currentActor: null },
		tenant,
	)
	return { root, databasePath, store, tenant, project, session }
}

describe('SQLite durability', () => {
	it('reopens exact message envelopes and compaction without discarding earlier receipts', async () => {
		const { store, databasePath, session, tenant } = await fixture()
		await store.appendMessage(session.id, createUserMessage('before compaction'), tenant)
		await store.replaceMessages(session.id, [createUserMessage('summary')], tenant)
		await store.appendMessage(session.id, createUserMessage('after compaction'), tenant)
		const expected = await store.loadSessionMessages(session.id, tenant)
		const reopened = new SqliteSessionStore({ databasePath, readOnly: true })
		expect(await reopened.loadSessionMessages(session.id, tenant)).toEqual(expected)
		expect((await reopened.loadMessages(session.id, tenant)).map((m) => m.content)).toEqual([
			'summary',
			'after compaction',
		])
		const db = new DatabaseSync(databasePath, { readOnly: true })
		try {
			expect(db.prepare('SELECT count(*) AS count FROM messages').get()?.count).toBe(3)
		} finally {
			db.close()
		}
	})

	it('read-only inspection leaves database bytes and directory entries unchanged', async () => {
		const { databasePath, root, tenant, session } = await fixture()
		const bytes = readFileSync(databasePath)
		const files = readdirSync(root)
		const reader = new SqliteSessionStore({ databasePath, readOnly: true })
		await reader.listProjects(tenant)
		await reader.loadMessages(session.id, tenant)
		expect(readFileSync(databasePath)).toEqual(bytes)
		expect(readdirSync(root)).toEqual(files)
		await expect(
			reader.appendMessage(session.id, createUserMessage('refuse'), tenant),
		).rejects.toThrow('read-only')
		const absent = join(root, 'absent', 'sessions.sqlite')
		await expect(
			new SqliteSessionStore({ databasePath: absent, readOnly: true }).listProjects(tenant),
		).rejects.toThrow()
		expect(existsSync(join(root, 'absent'))).toBe(false)
	})

	it('canonical directory lookup preserves tenant isolation and one root binding', async () => {
		const { root, store, project, tenant } = await fixture()
		const alias = join(root, 'alias')
		symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
		expect(await store.findProjectByRootPath(alias, tenant)).toEqual(project)
		await expect(
			store.createProject({ tenantId: tenant, name: 'duplicate', rootPath: alias }, tenant),
		).rejects.toThrow(/already|bound|root/i)
		const otherTenant = generateTenantId()
		expect(await store.findProjectByRootPath(root, otherTenant)).toBeNull()
		const other = await store.createProject(
			{ tenantId: otherTenant, name: 'other owner', rootPath: root },
			otherTenant,
		)
		expect(other.id).not.toBe(project.id)
		await store.updateProject(project.id, { maxDelegationWidth: 12 }, tenant)
		expect((await store.getProject(project.id, tenant))?.config.maxDelegationWidth).toBe(12)
		await store.setProjectStatus(project.id, 'archived', tenant, 0)
		await expect(store.setProjectStatus(project.id, 'open', tenant, 0)).rejects.toThrow()
	})

	it('commits a summary with the terminal transition and revives decision timestamps', async () => {
		const { store, databasePath, session, tenant } = await fixture()
		await store.updateSession({ ...session, status: 'active' }, tenant)
		const summary: SessionSummaryRef = {
			id: generateSummaryId(),
			sessionRef: session.id,
			tenantId: tenant,
			outcome: { status: 'succeeded' },
			deliverables: [],
			agentSummary: 'done',
			keyDecisions: [{ at: new Date(), summary: 'retain identity' }],
			at: new Date(),
			materializedBy: 'kernel',
		}
		await store.recordSummary(summary, tenant)
		const reader = new SqliteSessionStore({ databasePath, readOnly: true })
		expect(await reader.getSummary(session.id, tenant)).toEqual(summary)
		expect((await reader.getSession(session.id, tenant))?.status).toBe('idle')
		await expect(
			store.recordSummary({ ...summary, id: generateSummaryId() }, tenant),
		).rejects.toThrow()
		expect(await reader.getSummary(session.id, tenant)).toEqual(summary)
	})

	it('permits only one ownership update across independent processes', async () => {
		const { databasePath, store, session, tenant } = await fixture()
		const loader = createRequire(import.meta.url).resolve('tsx')
		const source = `
import { SqliteSessionStore } from ${JSON.stringify(new URL('../sqlite.ts', import.meta.url).href)};
const store = new SqliteSessionStore({ databasePath: ${JSON.stringify(databasePath)} });
const session = await store.getSession(${JSON.stringify(session.id)}, ${JSON.stringify(tenant)});
process.stdout.write('ready\\n');
process.stdin.once('data', async () => {
 try { await store.updateSession({ ...session, ownerVersion: session.ownerVersion + 1 }, ${JSON.stringify(tenant)}, session.ownerVersion); process.stdout.write('won'); }
 catch (error) { if (error.name !== 'StaleSessionError') { process.stderr.write(String(error)); process.exitCode = 1; } else process.stdout.write('stale'); }
 process.stdin.destroy();
});`
		const workers = Array.from({ length: 3 }, () => {
			const child = spawn(
				process.execPath,
				['--import', loader, '--input-type=module', '-e', source],
				{ stdio: ['pipe', 'pipe', 'pipe'] },
			)
			let output = ''
			let error = ''
			const ready = new Promise<void>((resolve, reject) => {
				child.once('error', reject)
				child.once('exit', () => {
					if (!output.includes('ready')) reject(new Error(error || 'worker exited before ready'))
				})
				child.stdout.on('data', (chunk) => {
					output += chunk
					if (output.includes('ready')) resolve()
				})
			})
			child.stderr.on('data', (chunk) => {
				error += chunk
			})
			const done = new Promise<void>((resolve, reject) => {
				child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(error))))
			})
			return { child, ready, done, result: () => output.replace('ready\n', '') }
		})
		try {
			await Promise.all(workers.map((w) => w.ready))
			for (const worker of workers) worker.child.stdin.write('go')
			await Promise.all(workers.map((w) => w.done))
			expect(workers.map((w) => w.result()).sort()).toEqual(['stale', 'stale', 'won'])
			expect((await store.getSession(session.id, tenant))?.ownerVersion).toBe(1)
		} finally {
			for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill()
		}
	}, 15_000)
})
