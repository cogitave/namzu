import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Operator } from './operator.js'

const owners: Operator[] = []
const directories: string[] = []
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it('opens one ordinary context without creating a Pal or conversation before the first send', async () => {
	const userData = await mkdtemp(join(tmpdir(), 'namzu-chat-operator-'))
	directories.push(userData)
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
		},
		() => {},
		userData,
	)
	owners.push(owner)
	const [a, b] = await Promise.all([owner.openChat(), owner.openChat()])
	expect(a).toEqual(b)
	expect(a).toMatchObject({ name: 'Chat', trusted: true, status: 'ready', isChat: true })
	expect(a.palId).toBeUndefined()
	expect(owner.listProjects()).toHaveLength(1)
	expect(await owner.listConversations(a.id)).toEqual([])
	expect(await owner.openProject(a.path)).toMatchObject({ id: a.id, isChat: true })
	const conversation = await owner.newConversation(a.id)
	expect(conversation.projectId).toBe(a.id)
	expect(conversation.palId).toBeUndefined()
})
