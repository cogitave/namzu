import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Operator } from './operator.js'
const directories: string[] = []
const owners: Operator[] = []
afterEach(async () => {
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-harness-operator-'))
	directories.push(root)
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
		},
		() => {},
		root,
	)
	owners.push(owner)
	return { owner, project: await owner.openChat() }
}
it('keeps execution engines, drafts and model choices scoped to each ordinary conversation', async () => {
	const { owner, project } = await fixture()
	const first = await owner.newConversation(project.id)
	const second = await owner.newConversation(project.id)
	owner.saveDraft(first.id, 'Unsent Namzu draft')
	owner.saveDraftSettings(first.id, {
		choice: { provider: 'zen', model: 'space-bunny-free' },
	})
	await owner.selectHarness(second.id, 'codex-cli')
	expect((await owner.harnesses(project.id, first.id)).selected).toBe('namzu')
	expect((await owner.harnesses(project.id, second.id)).selected).toBe('codex-cli')
	expect(owner.draft(first.id)).toBe('Unsent Namzu draft')
	expect(owner.draftSettings(first.id).choice?.provider).toBe('zen')
	expect(
		(await owner.listConversations(project.id)).find((row) => row.id === second.id)?.harness,
	).toBe('codex-cli')
})
it('rejects cross-project engine reads and unknown engines before delegation', async () => {
	const { owner, project } = await fixture()
	const session = await owner.newConversation(project.id)
	const other = await mkdtemp(join(tmpdir(), 'namzu-harness-other-'))
	directories.push(other)
	const otherProject = await owner.openProject(other)
	await expect(owner.harnesses(otherProject.id, session.id)).rejects.toThrow('another project')
	await expect(owner.selectHarness(session.id, 'other' as never)).rejects.toThrow(
		'Unknown execution engine',
	)
})
it('retains unsupported external-engine attachments and permissions before prompt admission', async () => {
	const { owner, project } = await fixture()
	const session = await owner.newConversation(project.id)
	await owner.selectHarness(session.id, 'claude-code')
	owner.saveDraft(session.id, 'Retained draft')
	const files = owner.addAttachments(session.id, [
		{ name: 'notes.txt', bytes: new TextEncoder().encode('Keep this file') },
	])
	expect(() =>
		owner.send(session.id, 'No send', {
			attachmentIds: files.map((file) => file.id),
		}),
	).toThrow('does not support attachments')
	expect(() => owner.send(session.id, 'No send', { permissionMode: 'auto' })).toThrow(
		'Ask first and Plan',
	)
	expect(owner.draft(session.id)).toBe('Retained draft')
	expect(owner.attachments(session.id)).toHaveLength(1)
})
