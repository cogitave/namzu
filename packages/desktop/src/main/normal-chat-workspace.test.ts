import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { isNormalChatWorkspace, normalChatWorkspace } from './normal-chat-workspace.js'

const owned: string[] = []
afterEach(async () => {
	await Promise.all(owned.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function directory() {
	const path = await mkdtemp(join(tmpdir(), 'namzu-chat-'))
	owned.push(path)
	return path
}

it('creates and recognizes only an app-owned normal context across reopen', async () => {
	const userData = await directory()
	const path = await normalChatWorkspace(userData)
	expect(await normalChatWorkspace(userData)).toBe(path)
	expect(await isNormalChatWorkspace(path, userData)).toBe(true)
	expect(await isNormalChatWorkspace(userData, userData)).toBe(false)
	expect(await isNormalChatWorkspace(path)).toBe(false)
	expect(await readFile(join(path, '.desktop-chat.json'), 'utf8')).toContain('namzu-desktop-chat')
})

it('refuses preexisting unmarked directories rather than implicitly trusting their files', async () => {
	const userData = await directory()
	await mkdir(join(userData, 'chats'))
	await writeFile(join(userData, 'chats', 'existing.txt'), 'leave me intact')
	await expect(normalChatWorkspace(userData)).rejects.toThrow()
	expect(await isNormalChatWorkspace(join(userData, 'chats'), userData)).toBe(false)
	expect(await readFile(join(userData, 'chats', 'existing.txt'), 'utf8')).toBe('leave me intact')
})

it('refuses a redirected context and an altered ownership marker', async () => {
	const userData = await directory()
	const foreign = await directory()
	await symlink(foreign, join(userData, 'chats'), process.platform === 'win32' ? 'junction' : 'dir')
	await expect(normalChatWorkspace(userData)).rejects.toThrow('redirected')
	expect(await isNormalChatWorkspace(join(userData, 'chats'), userData)).toBe(false)
	const otherData = await directory()
	const path = await normalChatWorkspace(otherData)
	await writeFile(join(path, '.desktop-chat.json'), 'foreign marker')
	await expect(normalChatWorkspace(otherData)).rejects.toThrow('does not belong')
})
