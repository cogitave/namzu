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

	it('writes and appends per-worker briefs without losing earlier sections', async () => {
		const hostRoot = await mkdtemp(join(tmpdir(), 'namzu-shared-workspace-'))
		const workspace = await SharedRunWorkspace.create({
			hostRoot,
			runtimeRoot: '/mnt/user-data/outputs/_work',
		})

		const briefPath = await workspace.writeAgentBrief({
			agentId: 'solution-architecture',
			taskId: 'task_abc',
			briefText: '# Worker Brief\n\n## Assignment\n\nDraft the solution architecture section.',
		})
		expect(briefPath).toBe(
			'/mnt/user-data/outputs/_work/agents/solution-architecture/task_abc/00_brief.md',
		)

		const appended = await workspace.appendAgentBrief({
			agentId: 'solution-architecture',
			taskId: 'task_abc',
			sectionText: '## Follow-up 2026-05-10T18:00:00.000Z\n\n### Follow-up message\n\nAdd a risks subsection.',
		})
		expect(appended).toBe(briefPath)

		const hostBriefPath = join(
			hostRoot,
			'agents',
			'solution-architecture',
			'task_abc',
			'00_brief.md',
		)
		const content = await readFile(hostBriefPath, 'utf8')
		expect(content).toContain('Draft the solution architecture section.')
		expect(content).toContain('Add a risks subsection.')
		// Initial seed must precede the appended section, not the other way around.
		const seedIndex = content.indexOf('Draft the solution architecture')
		const followIndex = content.indexOf('Add a risks subsection.')
		expect(seedIndex).toBeGreaterThan(-1)
		expect(followIndex).toBeGreaterThan(seedIndex)
	})

	it('writeTaskContext stores the user request verbatim under 01_task_context.md', async () => {
		const hostRoot = await mkdtemp(join(tmpdir(), 'namzu-shared-workspace-'))
		const workspace = await SharedRunWorkspace.create({
			hostRoot,
			runtimeRoot: '/mnt/user-data/outputs/_work',
		})

		const big = '# Task Context\n\n' + 'A'.repeat(40_000)
		const path = await workspace.writeTaskContext(big)
		expect(path).toBe('/mnt/user-data/outputs/_work/01_task_context.md')
		expect(workspace.refs().taskContextPath).toBe(path)
		const content = await readFile(join(hostRoot, '01_task_context.md'), 'utf8')
		// Trailing newline added by the writer is OK; user content must not be truncated.
		expect(content.length).toBeGreaterThanOrEqual(big.length)
		expect(content).toContain('A'.repeat(40_000))
	})

	it('rejects host paths that escape the shared workspace root', async () => {
		const hostRoot = await mkdtemp(join(tmpdir(), 'namzu-shared-workspace-'))
		const workspace = await SharedRunWorkspace.create({ hostRoot })

		expect(() => workspace.hostPath('..', 'outside')).toThrow(/escapes root/)
	})
})
