import { mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import {
	ProjectRootPathTakenError,
	StaleTopicError,
	TenantIsolationError,
} from '../../session/errors.js'
import type { Project } from '../../types/project/entity.js'
import type { Topic } from '../../types/topic/entity.js'
import {
	InvalidIdError,
	asProjectId,
	asTenantId,
	asTopicId,
	generateProjectId,
	generateTenantId,
	generateTopicId,
} from '../../utils/id.js'
import { InMemorySessionStore } from '../session/memory.js'
import { InMemoryTopicStore } from '../topic/memory.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
	await removeTempDirs(temporaryDirectories)
	temporaryDirectories.length = 0
})

function snapshot(format: 'uuid' | 'legacy'): { project: Project; topic: Topic } {
	const tenantId = format === 'uuid' ? generateTenantId() : asTenantId('tnt_hydration')
	const project: Project = {
		id: format === 'uuid' ? generateProjectId() : asProjectId('prj_hydration'),
		tenantId,
		name: 'Existing project',
		config: { maxDelegationDepth: 7, maxDelegationWidth: 12, maxInterventionDepth: 3 },
		status: 'open',
		ownerVersion: 9,
		createdAt: new Date('2025-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
	}
	const topic: Topic = {
		id: format === 'uuid' ? generateTopicId() : asTopicId('top_hydration'),
		projectId: project.id,
		tenantId,
		title: 'Existing topic',
		status: 'open',
		ownerVersion: 4,
		createdAt: new Date('2025-02-01T00:00:00Z'),
		updatedAt: new Date('2026-02-01T00:00:00Z'),
	}
	return { project, topic }
}

describe('hydration attaches isolated work to established project and topic identities', () => {
	it.each(['uuid', 'legacy'] as const)(
		'preserves %s identity, configuration, chronology, and parent ownership',
		async (format) => {
			const { project, topic } = snapshot(format)
			const sessions = new InMemorySessionStore([project])
			const topics = new InMemoryTopicStore([topic])
			expect(await sessions.getProject(project.id, project.tenantId)).toEqual(project)
			expect(await topics.getTopic(topic.id, topic.tenantId)).toEqual(topic)
			const session = await sessions.createSession(
				{
					projectId: project.id,
					topicId: topic.id,
					currentActor: { kind: 'agent', agentId: 'worker', tenantId: project.tenantId },
				},
				project.tenantId,
			)
			expect(session.projectId).toBe(project.id)
			expect(session.topicId).toBe(topic.id)
			expect(await sessions.listProjects(project.tenantId)).toHaveLength(1)
			expect(await topics.listTopics(project.id, project.tenantId)).toEqual([topic])
			await expect(sessions.getProject(project.id, generateTenantId())).rejects.toBeInstanceOf(
				TenantIsolationError,
			)
			await expect(topics.getTopic(topic.id, generateTenantId())).rejects.toBeInstanceOf(
				TenantIsolationError,
			)
		},
	)

	it('takes a private snapshot and continues topic compare-and-swap at the existing revision', async () => {
		const { project, topic } = snapshot('uuid')
		const sessions = new InMemorySessionStore([project])
		const topics = new InMemoryTopicStore([topic])
		const originalProject = structuredClone(project)
		const originalTopic = structuredClone(topic)
		project.config.maxDelegationWidth = 900
		project.createdAt.setFullYear(2030)
		topic.title = 'Parent changed after snapshot'
		topic.createdAt.setFullYear(2030)
		expect(await sessions.getProject(project.id, project.tenantId)).toEqual(originalProject)
		expect(await topics.getTopic(topic.id, topic.tenantId)).toEqual(originalTopic)
		await topics.updateTopic({ ...originalTopic, title: 'Child update' }, topic.tenantId)
		expect((await topics.getTopic(topic.id, topic.tenantId))?.ownerVersion).toBe(5)
		await expect(topics.updateTopic(originalTopic, topic.tenantId)).rejects.toBeInstanceOf(
			StaleTopicError,
		)
		expect(topic.ownerVersion).toBe(4)
		expect(topic.title).toBe('Parent changed after snapshot')
	})

	it('canonicalizes hydrated roots and enforces uniqueness within each tenant', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-hydrated-root-'))
		temporaryDirectories.push(root)
		const alias = `${root}-alias`
		await symlink(root, alias, 'junction')
		temporaryDirectories.push(alias)
		const { project } = snapshot('uuid')
		const bound = { ...project, rootPath: alias }
		const sessions = new InMemorySessionStore([bound])
		expect((await sessions.findProjectByRootPath(root, project.tenantId))?.id).toBe(project.id)
		expect((await sessions.getProject(project.id, project.tenantId))?.rootPath).toBe(root)
		expect(
			() =>
				new InMemorySessionStore([bound, { ...project, id: generateProjectId(), rootPath: root }]),
		).toThrow(ProjectRootPathTakenError)
		const other = {
			...project,
			id: generateProjectId(),
			tenantId: generateTenantId(),
			rootPath: root,
		}
		const shared = new InMemorySessionStore([bound, other])
		expect((await shared.findProjectByRootPath(root, other.tenantId))?.id).toBe(other.id)
	})

	it('rejects duplicate identities and malformed snapshot IDs before accepting a store', () => {
		const { project, topic } = snapshot('legacy')
		expect(() => new InMemorySessionStore([project, project])).toThrow(/Duplicate project/)
		expect(() => new InMemoryTopicStore([topic, topic])).toThrow(/Duplicate topic/)
		expect(
			() => new InMemorySessionStore([{ ...project, id: 'prj_../outside' as Project['id'] }]),
		).toThrow(InvalidIdError)
		expect(() => new InMemoryTopicStore([{ ...topic, id: 'thd_old' as Topic['id'] }])).toThrow(
			InvalidIdError,
		)
	})
})
