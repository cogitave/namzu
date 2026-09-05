import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { fixtureUuid, unchecked } from '../../../test-support/ids.js'
import type { ProjectId, SessionId, SubSessionId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import {
	InvalidIdError,
	asProjectId,
	asSessionId,
	asSubSessionId,
	asTenantId,
	asTopicId,
	asUserId,
	generateTopicId,
} from '../../../utils/id.js'
import { DiskSessionStore } from '../disk.js'

const TENANT = asTenantId('372188c0-476a-4af2-a9ba-c02a491a0d25')
const TOPIC = asTopicId('c7c29b04-1b32-4dbf-9682-6d1cfe074ba9')
const roots: string[] = []

afterEach(async () => {
	await removeTempDirs(roots.splice(0))
})

async function fixture() {
	const rootDir = await mkdtemp(join(tmpdir(), 'namzu-session-storage-id-'))
	roots.push(rootDir)
	const store = new DiskSessionStore({ rootDir })
	const project = await store.createProject({ tenantId: TENANT, name: 'project' }, TENANT)
	return { rootDir, store, project }
}

describe('DiskSessionStore id boundaries', () => {
	it.each([
		'ses_',
		'ses_previously_safe',
		'ses_/../../../../outside',
		'ses_\\..\\outside',
		'ses_a:stream',
		'ses_a.b',
		'ses_a b',
		'ses_a\n',
	])('refuses a caller-chosen unsafe id %j before creating any session files', async (rawId) => {
		const { rootDir, store, project } = await fixture()
		const projectDir = join(rootDir, 'projects', project.id)
		const projectPath = join(projectDir, 'project.json')
		const before = await readFile(projectPath, 'utf8')

		await expect(
			store.createSession(
				{
					id: unchecked<SessionId>(rawId),
					projectId: project.id,
					topicId: TOPIC,
					currentActor: null,
				},
				TENANT,
			),
		).rejects.toBeInstanceOf(InvalidIdError)

		expect(await readdir(rootDir)).toEqual(['projects'])
		expect(await readdir(projectDir)).toEqual(['project.json'])
		expect(await readFile(projectPath, 'utf8')).toBe(before)
	})

	it('validates branded assertions at project, session and sub-session entry points', async () => {
		const { store } = await fixture()
		const project = unchecked<ProjectId>('prj_/../../outside')
		const session = unchecked<SessionId>('ses_/../../outside')
		const subSession = unchecked<SubSessionId>('sub_/../../outside')

		await expect(store.getProject(project, TENANT)).rejects.toBeInstanceOf(InvalidIdError)
		await expect(store.listSessionsByProject(project, TENANT)).rejects.toBeInstanceOf(
			InvalidIdError,
		)
		await expect(store.getSession(session, TENANT)).rejects.toBeInstanceOf(InvalidIdError)
		await expect(store.deleteSession(session, TENANT)).rejects.toBeInstanceOf(InvalidIdError)
		await expect(store.getSubSession(subSession, TENANT)).rejects.toBeInstanceOf(InvalidIdError)
		await expect(store.deleteSubSession(subSession, TENANT)).rejects.toBeInstanceOf(InvalidIdError)
	})

	it('preserves a safe caller-chosen id and its messages across a cold reopen', async () => {
		const { rootDir, store, project } = await fixture()
		const id = asSessionId('0a0e4339-bdee-431d-ae33-b379bce18a26')
		const params = {
			id,
			projectId: project.id,
			topicId: TOPIC,
			currentActor: null,
		}
		expect((await store.createSession(params, TENANT)).id).toBe(id)
		await store.appendMessage(id, createUserMessage('keep this conversation'), TENANT)

		const reopened = new DiskSessionStore({ rootDir })
		expect(await reopened.getSession(id, TENANT)).toMatchObject({
			id,
			projectId: project.id,
		})
		expect((await reopened.listSessionsByProject(project.id, TENANT)).map((s) => s.id)).toEqual([
			id,
		])
		expect((await reopened.loadMessages(id, TENANT)).map((message) => message.content)).toEqual([
			'keep this conversation',
		])
		await expect(reopened.createSession(params, TENANT)).rejects.toThrow('already exists')
	})

	it('discovers caller-assigned project/session/sub-session UUIDs with no warm indexes', async () => {
		const { rootDir, store, project } = await fixture()
		const topicId = generateTopicId()
		const fixedProjectId = asProjectId('efb7000b-381a-453b-a468-3d87e3e7e68b')
		const fixedProjectDir = join(rootDir, 'projects', fixedProjectId)
		const originalProject = JSON.parse(
			await readFile(join(rootDir, 'projects', project.id, 'project.json'), 'utf8'),
		)
		await mkdir(fixedProjectDir)
		await writeFile(
			join(fixedProjectDir, 'project.json'),
			JSON.stringify({ ...originalProject, id: fixedProjectId }),
		)

		const pairs = []
		for (const [index, projectId] of [project.id, fixedProjectId].entries()) {
			const parent = await store.createSession({ projectId, topicId, currentActor: null }, TENANT)
			const child = await store.createSession(
				{
					id: asSessionId(fixtureUuid(`ses_Legacy-${index}`)),
					projectId,
					topicId,
					currentActor: null,
				},
				TENANT,
			)
			const sub = await store.createSubSession(
				{
					parentSessionId: parent.id,
					childSessionId: child.id,
					kind: 'agent_spawn',
					spawnedBy: {
						kind: 'user',
						userId: asUserId('52166135-9274-4790-b1f4-f3ad05554c6a'),
						tenantId: TENANT,
					},
				},
				TENANT,
			)
			let subId = sub.id
			if (index === 1) {
				const subsDir = join(fixedProjectDir, 'sessions', parent.id, 'subsessions')
				const raw = JSON.parse(await readFile(join(subsDir, sub.id, 'subsession.json'), 'utf8'))
				subId = asSubSessionId('c9466509-bb93-4d72-9b1a-4e077b2cc927')
				await rename(join(subsDir, sub.id), join(subsDir, subId))
				await writeFile(
					join(subsDir, subId, 'subsession.json'),
					JSON.stringify({ ...raw, id: subId }),
				)
			}
			await store.appendMessage(parent.id, createUserMessage(`history ${index}`), TENANT)
			pairs.push({ parent, child, subId, projectId })
		}

		// A separate reader for every operation prevents a successful listing
		// from hiding a broken direct lookup by warming its private ID index.
		const cold = () => new DiskSessionStore({ rootDir })
		expect(new Set((await cold().listProjects(TENANT)).map((row) => row.id))).toEqual(
			new Set([project.id, fixedProjectId]),
		)
		expect(
			new Set((await cold().listSessionsByTopic(topicId, TENANT)).map((row) => row.id)),
		).toEqual(new Set(pairs.flatMap(({ parent, child }) => [parent.id, child.id])))
		for (const [index, { parent, child, subId, projectId }] of pairs.entries()) {
			expect(await cold().getSession(parent.id, TENANT)).toMatchObject({ id: parent.id, projectId })
			expect(await cold().getSession(child.id, TENANT)).toMatchObject({ id: child.id, projectId })
			expect(await cold().getSubSession(subId, TENANT)).toMatchObject({ id: subId })
			expect(
				new Set((await cold().listSessionsByProject(projectId, TENANT)).map((row) => row.id)),
			).toEqual(new Set([parent.id, child.id]))
			expect(
				(await cold().loadMessages(parent.id, TENANT)).map((message) => message.content),
			).toEqual([`history ${index}`])
			expect((await cold().getChildren(parent.id, TENANT)).map((row) => row.id)).toEqual([subId])
			expect(await cold().getAncestry(child.id, TENANT)).toEqual([parent.id, child.id])
			await expect(cold().deleteSession(parent.id, TENANT)).rejects.toThrow('attached sub-sessions')
			await expect(cold().deleteSession(child.id, TENANT)).rejects.toThrow('attached sub-sessions')
			await cold().deleteSubSession(subId, TENANT)
			await cold().deleteSession(child.id, TENANT)
			await cold().deleteSession(parent.id, TENANT)
			expect(await cold().listSessionsByProject(projectId, TENANT)).toEqual([])
		}
	})
})
