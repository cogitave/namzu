import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SharedRunWorkspace } from '../shared-run.js'

describe('SharedRunWorkspace', () => {
	it('creates a canonical workspace manifest with runtime-visible paths', async () => {
		const hostRoot = await mkdtemp(join(tmpdir(), 'namzu-shared-workspace-'))
		const workspace = await SharedRunWorkspace.create({
			hostRoot,
			runtimeRoot: '/mnt/user-data/outputs/_work',
			label: 'Cowork task',
			now: new Date('2026-05-08T10:00:00.000Z'),
		})

		const manifest = await workspace.readManifest()
		expect(manifest.kind).toBe('shared-run-workspace')
		expect(manifest.label).toBe('Cowork task')
		expect(manifest.paths).toMatchObject({
			root: '/mnt/user-data/outputs/_work',
			manifest: '/mnt/user-data/outputs/_work/manifest.json',
			sources: '/mnt/user-data/outputs/_work/sources',
			plans: '/mnt/user-data/outputs/_work/plans',
			agents: '/mnt/user-data/outputs/_work/agents',
		})
		expect(workspace.refs().supervisorBriefPath).toBe(
			'/mnt/user-data/outputs/_work/00_supervisor_brief.md',
		)
	})

	it('records source inventory and seeded supervisor brief before workers launch', async () => {
		const hostRoot = await mkdtemp(join(tmpdir(), 'namzu-shared-workspace-'))
		const workspace = await SharedRunWorkspace.create({
			hostRoot,
			runtimeRoot: '/mnt/user-data/outputs/_work/',
		})

		await workspace.writeSourceInventory([
			{
				id: 'file_abc',
				label: 'SBD.docx',
				path: '/mnt/user-data/uploads/file_abc/SBD.docx',
				kind: 'docx',
				sizeBytes: 123,
			},
		])
		const briefPath = await workspace.seedSupervisorBrief({
			briefText: 'Root task seed brief',
		})
		const agentPath = await workspace.registerAgentWork({
			agentId: 'solution-architecture',
			taskId: 'task_123',
		})

		expect(briefPath).toBe('/mnt/user-data/outputs/_work/00_supervisor_brief.md')
		expect(agentPath).toBe('/mnt/user-data/outputs/_work/agents/solution-architecture/task_123')
		const inventory = await readFile(join(hostRoot, 'sources', 'inventory.md'), 'utf8')
		expect(inventory).toContain('SBD.docx')
		expect(inventory).toContain('/mnt/user-data/uploads/file_abc/SBD.docx')
		const manifest = await workspace.readManifest()
		expect(manifest.sources).toHaveLength(1)
		expect(manifest.plans[0]?.status).toBe('seeded')
		expect(manifest.agents[0]?.workPath).toBe(agentPath)
	})

	it('rejects host paths that escape the shared workspace root', async () => {
		const hostRoot = await mkdtemp(join(tmpdir(), 'namzu-shared-workspace-'))
		const workspace = await SharedRunWorkspace.create({ hostRoot })

		expect(() => workspace.hostPath('..', 'outside')).toThrow(/escapes root/)
	})
})
