import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopEvent } from '../shared/protocol.js'
import { DesktopConversationStore } from './desktop-conversation-store.js'
import { Operator } from './operator.js'
import { RuntimeClient } from './rpc-client.js'

const owners: Operator[] = []
const directories: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
function operator(directory: string, log: string) {
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: {
				...process.env,
				FIXTURE_ENFORCE_PROVIDER_BINDING: '1',
				FIXTURE_REQUEST_LOG: log,
			},
		},
		() => {},
		directory,
	)
	owners.push(owner)
	return owner
}
async function directory() {
	const value = await mkdtemp(join(tmpdir(), 'namzu-desktop-persist-'))
	directories.push(value)
	return value
}
async function requests(
	log: string,
): Promise<{ method: string; params?: Record<string, unknown> }[]> {
	return (await readFile(log, 'utf8'))
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line))
}

it('restores an unsent tab, exact model, draft and attachments into a fresh runtime without replaying a prompt', async () => {
	const root = await directory()
	const log = join(root, 'requests.ndjson')
	const before = operator(root, log)
	const project = await before.openProject(process.cwd())
	const view = await before.newConversation(project.id)
	await before.selectHarness(view.id, 'codex-cli')
	await before.selectProvider(view.id, 'codex-cli', 'confirmed-model')
	before.saveDraft(view.id, 'Authored unsent draft')
	before.saveDraftSettings(view.id, {
		choice: { provider: 'codex-cli', model: 'confirmed-model' },
		options: { effort: 'high', permissionMode: 'prompt' },
	})
	const attachments = before.addAttachments(view.id, [
		{ name: 'notes.txt', bytes: Buffer.from('Exact authored bytes') },
	])
	await before.close()
	owners.splice(owners.indexOf(before), 1)
	const after = operator(root, log)
	const reopened = await after.openProject(project.path)
	expect(reopened.id).toBe(project.id)
	expect(await after.listConversations(project.id)).toContainEqual({
		...view,
		harness: 'codex-cli',
	})
	expect(after.draft(view.id)).toBe('Authored unsent draft')
	expect(after.draftSettings(view.id)).toEqual({
		choice: { provider: 'codex-cli', model: 'confirmed-model' },
		options: { effort: 'high', permissionMode: 'prompt' },
	})
	expect(after.attachments(view.id)).toEqual(attachments)
	await after.openConversation(project.id, view.id)
	expect((await after.providers(project.id, view.id)).selected).toEqual({
		id: 'codex-cli',
		model: 'confirmed-model',
	})
	const catalogue = await after.models(project.id, 'codex-cli', view.id)
	expect(catalogue.models[0]?.id).not.toBe(`codex-cli-${view.id}`)
	const calls = await requests(log)
	expect(calls.filter((item) => item.method === 'session/new')).toHaveLength(2)
	expect(calls.filter((item) => item.method === 'session/load')).toEqual([])
	expect(calls.filter((item) => item.method === 'session/prompt')).toEqual([])
	expect(after.draft(view.id)).toBe('Authored unsent draft')
	expect(after.attachments(view.id)).toEqual(attachments)
})

it('loads a saved durable runtime directly even when the recent catalogue no longer returns its view id', async () => {
	const root = await directory()
	const log = join(root, 'requests.ndjson')
	const projectId = 'stable-old-project'
	const view = {
		id: 'older-ui-session',
		projectId,
		title: 'Older conversation',
		updatedAt: '2026-10-04T00:00:00.000Z',
	}
	new DesktopConversationStore(root).write({
		version: 1,
		projects: [{ id: projectId, path: process.cwd() }],
		conversations: [
			{
				view,
				runtimeSessionId: 'durable-runtime-alias',
				hasPrompted: true,
				draft: 'Future unsent message',
			},
		],
		projectDrafts: [],
		attachments: [],
	})
	const owner = operator(root, log)
	expect(owner.restoredProjectPaths([view.id])).toEqual([process.cwd()])
	const project = await owner.openProject(process.cwd())
	expect(project.id).toBe(projectId)
	expect(await owner.listConversations(projectId)).toContainEqual(view)
	await owner.openConversation(projectId, view.id)
	await owner.readyConversation(projectId, view.id)
	const calls = await requests(log)
	expect(calls.find((item) => item.method === 'session/load')?.params?.sessionId).toBe(
		'durable-runtime-alias',
	)
	expect(
		calls.find((item) => item.method === 'namzu/conversations/history')?.params?.sessionId,
	).toBe('durable-runtime-alias')
	expect(
		calls.filter((item) => item.method === 'session/new' || item.method === 'session/prompt'),
	).toEqual([])
	expect(owner.draft(view.id)).toBe('Future unsent message')
})

it('restores two independent blank pane drafts and their attachment identities under the same stable project', async () => {
	const root = await directory()
	const log = join(root, 'requests.ndjson')
	const before = operator(root, log)
	const project = await before.openProject(process.cwd())
	const a = `project:${project.id}:workspace:window-a:home-window-a`
	const b = `project:${project.id}:workspace:window-b:home-window-b`
	before.saveDraft(a, 'First blank pane')
	before.saveDraft(b, 'Second blank pane')
	before.saveDraftSettings(a, { options: { permissionMode: 'plan' } })
	const files = before.addAttachments(a, [
		{ name: 'blank.txt', bytes: Buffer.from('Blank pane file') },
	])
	await before.close()
	owners.splice(owners.indexOf(before), 1)
	const after = operator(root, log)
	await after.openProject(project.path)
	expect(after.draft(a)).toBe('First blank pane')
	expect(after.draft(b)).toBe('Second blank pane')
	expect(after.draftSettings(a)).toEqual({
		options: { permissionMode: 'plan' },
	})
	expect(after.attachments(a)).toEqual(files)
	expect(after.attachments(b)).toEqual([])
	expect(
		(await requests(log)).filter(
			(item) => item.method === 'session/new' || item.method === 'session/prompt',
		),
	).toEqual([])
})

it('restores the exact SDK provider and model when an unsent Namzu tab receives a replacement runtime', async () => {
	const root = await directory()
	const log = join(root, 'requests.ndjson')
	const before = operator(root, log)
	const project = await before.openProject(process.cwd())
	const view = await before.newConversation(project.id)
	await before.selectProvider(view.id, 'fixture', 'exact-sdk-model')
	before.saveDraftSettings(view.id, {
		choice: { provider: 'fixture', model: 'exact-sdk-model' },
	})
	await before.close()
	owners.splice(owners.indexOf(before), 1)
	const after = operator(root, log)
	await after.openProject(project.path)
	await after.openConversation(project.id, view.id)
	await after.readyConversation(project.id, view.id)
	const calls = await requests(log)
	const select = calls.filter((item) => item.method === 'namzu/providers/select')
	expect(select).toHaveLength(2)
	expect(select[1]?.params).toMatchObject({
		provider: 'fixture',
		model: 'exact-sdk-model',
	})
	expect(select[1]?.params?.sessionId).not.toBe(view.id)
	expect(calls.filter((item) => item.method === 'session/prompt')).toEqual([])
})

it.each(['empty', 'missing'])(
	'retains the full authored first prompt after confirmed %s history on preflight failure',
	async (mode) => {
		const root = await directory()
		const log = join(root, 'requests.ndjson')
		const events: DesktopEvent[] = []
		let resolveEnded: (() => void) | undefined
		const ended = new Promise<void>((resolve) => {
			resolveEnded = resolve
		})
		const before = new Operator(
			{
				program: process.execPath,
				args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
				env: {
					...process.env,
					FIXTURE_ENFORCE_PROVIDER_BINDING: '1',
					FIXTURE_REQUEST_LOG: log,
					FIXTURE_HISTORY_MODE: mode,
				},
			},
			(event) => {
				events.push(event)
				if (event.kind === 'state' && !event.running) resolveEnded?.()
			},
			root,
		)
		owners.push(before)
		const project = await before.openProject(process.cwd())
		const view = await before.newConversation(project.id)
		before.send(view.id, 'Reject turn with fixture')
		await ended
		expect(before.draft(view.id)).toBe('Reject turn with fixture')
		expect(
			events.filter((event) => event.kind === 'state' && event.restoredDraft !== undefined),
		).toEqual([
			expect.objectContaining({
				kind: 'state',
				sessionId: view.id,
				running: false,
				restoredDraft: 'Reject turn with fixture',
			}),
		])
		await before.close()
		owners.splice(owners.indexOf(before), 1)
		const after = operator(root, log)
		await after.openProject(project.path)
		await after.openConversation(project.id, view.id)
		await after.readyConversation(project.id, view.id)
		expect(after.draft(view.id)).toBe('Reject turn with fixture')
		const calls = await requests(log)
		expect(calls.filter((item) => item.method === 'session/load')).toEqual([])
		expect(calls.filter((item) => item.method === 'session/prompt')).toHaveLength(1)
		expect(calls.filter((item) => item.method === 'session/new')).toHaveLength(2)
	},
)

it.each(['Newer authored request', '', 'Reject turn with fixture'])(
	'preserves a newer authored draft %j and publishes no stale recovery after first-prompt refusal',
	async (nextDraft) => {
		const root = await directory()
		const events: DesktopEvent[] = []
		let resolveEntered!: () => void
		const entered = new Promise<void>((resolve) => {
			resolveEntered = resolve
		})
		let resolveRelease!: () => void
		const release = new Promise<void>((resolve) => {
			resolveRelease = resolve
		})
		let resolveEnded!: () => void
		const ended = new Promise<void>((resolve) => {
			resolveEnded = resolve
		})
		const owner = new Operator(
			{
				program: process.execPath,
				args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
				env: { ...process.env, FIXTURE_HISTORY_MODE: 'empty' },
			},
			(event) => {
				events.push(event)
				if (event.kind === 'state' && !event.running) resolveEnded()
			},
			root,
		)
		owners.push(owner)
		const project = await owner.openProject(process.cwd())
		const view = await owner.newConversation(project.id)
		const request = RuntimeClient.prototype.request
		vi.spyOn(RuntimeClient.prototype, 'request').mockImplementation(async function (
			this: RuntimeClient,
			method,
			params,
			timeout,
		) {
			if (method === 'session/prompt') {
				resolveEntered()
				await release
			}
			return await request.call(this, method, params, timeout)
		})
		owner.saveDraft(view.id, 'Reject turn with fixture')
		owner.send(view.id, 'Reject turn with fixture')
		await entered
		owner.saveDraft(view.id, nextDraft)
		resolveRelease()
		await ended
		expect(owner.draft(view.id)).toBe(nextDraft)
		expect(
			events.filter((event) => event.kind === 'state' && event.restoredDraft !== undefined),
		).toEqual([])
		expect(new DesktopConversationStore(root).read()?.conversations[0]?.draft).toBe(nextDraft)
	},
)

it.each(['foreign', 'unreadable', 'wrong-session', 'partial'])(
	'keeps durable runtime authority when first failure history is %s',
	async (mode) => {
		const root = await directory()
		let resolveEnded: (() => void) | undefined
		const ended = new Promise<void>((resolve) => {
			resolveEnded = resolve
		})
		const owner = new Operator(
			{
				program: process.execPath,
				args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
				env: { ...process.env, FIXTURE_HISTORY_MODE: mode },
			},
			(event) => {
				if (event.kind === 'state' && !event.running) resolveEnded?.()
			},
			root,
		)
		owners.push(owner)
		const project = await owner.openProject(process.cwd())
		const view = await owner.newConversation(project.id)
		owner.send(view.id, 'Reject turn with fixture')
		owner.saveDraft(view.id, 'Newer user draft')
		await ended
		const saved = new DesktopConversationStore(root).read()?.conversations[0]
		expect(saved).toMatchObject({
			hasPrompted: true,
			runtimeSessionId: view.id,
			draft: 'Newer user draft',
		})
	},
)

it('keeps a Pal marked unread across a restart until it is read, and refuses a bad id', async () => {
	const root = await directory()
	const log = join(root, 'requests.ndjson')
	const before = operator(root, log)
	// A conversation exists so the desktop file is written with its other data.
	const project = await before.openProject(process.cwd())
	await before.newConversation(project.id)
	expect(before.setPalUnread('pal-a', true)).toEqual(['pal-a'])
	expect(before.setPalUnread('pal-b', true)).toEqual(['pal-a', 'pal-b'])
	expect(before.setPalUnread('pal-a', true)).toEqual(['pal-a', 'pal-b'])
	expect(() => before.setPalUnread('', true)).toThrow('Invalid Pal')
	expect(() => before.setPalUnread('x'.repeat(401), true)).toThrow('Invalid Pal')
	expect(() => before.setPalUnread('bad\u0001id', true)).toThrow('Invalid Pal')
	expect(() => before.setPalUnread('pal-a', 'yes')).toThrow('Invalid Pal')
	await before.close()
	owners.splice(owners.indexOf(before), 1)

	const after = operator(root, log)
	expect(after.palUnread()).toEqual(['pal-a', 'pal-b'])
	// Opening the Pal reads it; that too survives a restart.
	expect(after.setPalUnread('pal-a', false)).toEqual(['pal-b'])
	expect(after.setPalUnread('pal-a', false)).toEqual(['pal-b'])
	await after.close()
	owners.splice(owners.indexOf(after), 1)
	expect(operator(root, log).palUnread()).toEqual(['pal-b'])
})
