import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { unchecked } from '../../../test-support/ids.js'
import type { ProjectId, SessionId, SubSessionId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import { InvalidIdError, asSessionId, asTenantId, asTopicId } from '../../../utils/id.js'
import { DiskSessionStore } from '../disk.js'

const TENANT = asTenantId('tnt_storage_ids')
const TOPIC = asTopicId('top_storage_ids')
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
		const id = asSessionId('ses_Selected-A_1')
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
})
