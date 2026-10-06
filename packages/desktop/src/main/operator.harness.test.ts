import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { DesktopEvent } from '../shared/protocol.js'
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
	const events = new EventEmitter()
	const requestLog = join(root, 'requests.jsonl')
	const rejectedSelection = join(root, 'reject-selection')
	const defaultModel = join(root, 'default-model')
	const untrusted = join(root, 'untrusted')
	const rejectedMetadata = join(root, 'reject-metadata')
	const delayedDiscovery = join(root, 'delay-discovery')
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: {
				...process.env,
				FIXTURE_REQUEST_LOG: requestLog,
				FIXTURE_ENFORCE_PROVIDER_BINDING: '1',
				FIXTURE_REJECT_SELECTION_FILE: rejectedSelection,
				FIXTURE_DEFAULT_MODEL_FILE: defaultModel,
				FIXTURE_UNTRUSTED_FILE: untrusted,
				FIXTURE_REJECT_METADATA_FILE: rejectedMetadata,
				FIXTURE_DELAY_DISCOVERY_FILE: delayedDiscovery,
			},
		},
		(event) => events.emit('update', event),
		root,
	)
	owners.push(owner)
	const wait = (predicate: (event: DesktopEvent) => boolean): Promise<DesktopEvent> =>
		new Promise((resolve) => {
			const receive = (event: DesktopEvent) => {
				if (predicate(event)) {
					events.off('update', receive)
					resolve(event)
				}
			}
			events.on('update', receive)
		})
	const calls = async () =>
		(await readFile(requestLog, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
	return {
		owner,
		project: await owner.openChat(),
		wait,
		calls,
		rejectedSelection,
		defaultModel,
		untrusted,
		rejectedMetadata,
		delayedDiscovery,
	}
}
async function disconnect(f: Awaited<ReturnType<typeof fixture>>) {
	const breaker = await f.owner.newConversation(f.project.id)
	const failed = f.wait((event) => event.kind === 'connection' && event.project.status === 'error')
	f.owner.send(breaker.id, 'Break connection')
	await failed
	await f.owner.reconnect(f.project.id)
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

it.each(['codex-cli', 'claude-code'] as const)(
	'restores an unsent %s draft, exact model and owner before concurrent metadata reads',
	async (engine) => {
		const f = await fixture()
		const session = await f.owner.newConversation(f.project.id)
		const other = await f.owner.newConversation(f.project.id)
		f.owner.saveDraft(other.id, 'Another conversation stays separate')
		await f.owner.selectHarness(session.id, engine)
		await f.owner.selectProvider(session.id, engine, `${engine}-applied`)
		f.owner.saveDraft(session.id, 'Keep my unsubmitted request')
		const settings = {
			choice: { provider: engine, model: `${engine}-chosen`, label: 'My chosen model' },
			options: { permissionMode: 'plan' as const },
		}
		f.owner.saveDraftSettings(session.id, settings)
		await disconnect(f)
		const before = await f.calls()
		const [harness, providers, catalogue] = await Promise.all([
			f.owner.harnesses(f.project.id, session.id),
			f.owner.providers(f.project.id, session.id),
			f.owner.models(f.project.id, engine, session.id),
			f.owner.openConversation(f.project.id, session.id),
		])
		expect(harness.selected).toBe(engine)
		expect(providers.selected).toEqual({ id: engine, model: `${engine}-chosen` })
		const requests = (await f.calls()).slice(before.length)
		expect(requests.filter((call) => call.method === 'session/new')).toHaveLength(1)
		const selections = requests.filter((call) => call.method === 'namzu/providers/select')
		expect(selections).toHaveLength(1)
		const runtimeId = selections[0]?.params.sessionId
		expect(runtimeId).not.toBe(session.id)
		expect(selections[0]?.params).toEqual({
			sessionId: runtimeId,
			provider: engine,
			model: `${engine}-chosen`,
		})
		expect(catalogue.models[0]?.id).toBe(`${engine}-${runtimeId}`)
		expect(requests.filter((call) => call.method === 'session/prompt')).toEqual([])
		expect(requests.filter((call) => call.method === 'session/load')).toEqual([])
		expect(f.owner.draft(session.id)).toBe('Keep my unsubmitted request')
		expect(f.owner.draftSettings(session.id)).toEqual(settings)
		expect(f.owner.draft(other.id)).toBe('Another conversation stays separate')
		expect(await f.owner.listConversations(f.project.id)).toContainEqual(
			expect.objectContaining({ id: session.id, harness: engine }),
		)
		const review = f.wait(
			(event) => event.kind === 'permission' && event.request.sessionId === session.id,
		)
		f.owner.send(session.id, f.owner.draft(session.id), settings.options)
		const request = await review
		if (request.kind !== 'permission') throw new Error('Missing first-message review')
		expect(request.request.calls[0]?.input).toEqual({
			prompt: 'Keep my unsubmitted request',
			engine,
			model: `${engine}-chosen`,
		})
		const ended = f.wait(
			(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
		)
		f.owner.approve(session.id, request.request.id, false)
		await ended
	},
)

it('retains the actual default model when a new connection offers a different default', async () => {
	const f = await fixture()
	const session = await f.owner.newConversation(f.project.id)
	await f.owner.selectHarness(session.id, 'codex-cli')
	f.owner.saveDraft(session.id, 'Retain the selected default')
	await writeFile(f.defaultModel, 'different-current-default')
	await disconnect(f)
	expect((await f.owner.providers(f.project.id, session.id)).selected).toEqual({
		id: 'codex-cli',
		model: 'codex-cli-default',
	})
	expect(f.owner.draft(session.id)).toBe('Retain the selected default')
})

it.each(['initial', 'replacement'] as const)(
	'returns the acknowledged %s engine selection when model metadata fails, then retries that read',
	async (stage) => {
		const f = await fixture()
		const session = await f.owner.newConversation(f.project.id)
		f.owner.saveDraft(session.id, 'Keep the acknowledged engine and my draft')
		if (stage === 'replacement') {
			await f.owner.selectHarness(session.id, 'codex-cli')
			await disconnect(f)
		}
		await writeFile(f.rejectedMetadata, '')
		await expect(f.owner.selectHarness(session.id, 'claude-code')).resolves.toMatchObject({
			selected: 'claude-code',
		})
		expect((await f.owner.harnesses(f.project.id, session.id)).selected).toBe('claude-code')
		await expect(f.owner.providers(f.project.id, session.id)).rejects.toThrow('model metadata')
		expect(f.owner.draft(session.id)).toBe('Keep the acknowledged engine and my draft')
		await rm(f.rejectedMetadata)
		expect((await f.owner.providers(f.project.id, session.id)).selected).toEqual({
			id: 'claude-code',
			model: 'claude-code-default',
		})
		await writeFile(f.defaultModel, 'different-model-on-reconnect')
		await disconnect(f)
		expect((await f.owner.providers(f.project.id, session.id)).selected).toEqual({
			id: 'claude-code',
			model: 'claude-code-default',
		})
		expect(
			(await f.calls()).filter(
				(call) => call.method === 'session/prompt' && call.params.prompt !== 'Break connection',
			),
		).toEqual([])
	},
)

it('refuses to guess a model after reconnect when acknowledged selection metadata was never captured', async () => {
	const f = await fixture()
	const session = await f.owner.newConversation(f.project.id)
	f.owner.saveDraft(session.id, 'An unknown old model must not change silently')
	await writeFile(f.rejectedMetadata, '')
	expect((await f.owner.selectHarness(session.id, 'codex-cli')).selected).toBe('codex-cli')
	await rm(f.rejectedMetadata)
	await writeFile(f.defaultModel, 'different-current-default')
	await disconnect(f)
	const before = await f.calls()
	await expect(f.owner.providers(f.project.id, session.id)).rejects.toThrow(
		'model settings could not be read',
	)
	expect(f.owner.draft(session.id)).toBe('An unknown old model must not change silently')
	expect(
		(await f.calls())
			.slice(before.length)
			.filter((call) => call.method === 'namzu/providers/select'),
	).toEqual([])
	expect((await f.owner.selectHarness(session.id, 'codex-cli')).selected).toBe('codex-cli')
	expect((await f.owner.providers(f.project.id, session.id)).selected).toEqual({
		id: 'codex-cli',
		model: 'different-current-default',
	})
})

it('keeps confirmed engine selection when malformed metadata omits its model, and rejects that metadata', async () => {
	const f = await fixture()
	const session = await f.owner.newConversation(f.project.id)
	await writeFile(f.rejectedMetadata, 'empty')
	expect((await f.owner.selectHarness(session.id, 'codex-cli')).selected).toBe('codex-cli')
	await expect(f.owner.providers(f.project.id, session.id)).rejects.toThrow(
		'did not report its selected model',
	)
	await rm(f.rejectedMetadata)
	expect((await f.owner.providers(f.project.id, session.id)).selected?.model).toBe(
		'codex-cli-default',
	)
})

it('retains an already known model when reselecting the same acknowledged engine cannot refresh metadata', async () => {
	const f = await fixture()
	const session = await f.owner.newConversation(f.project.id)
	await f.owner.selectHarness(session.id, 'codex-cli')
	await f.owner.selectProvider(session.id, 'codex-cli', 'known-selected-model')
	await writeFile(f.rejectedMetadata, '')
	expect((await f.owner.selectHarness(session.id, 'codex-cli')).selected).toBe('codex-cli')
	await rm(f.rejectedMetadata)
	await writeFile(f.defaultModel, 'different-current-default')
	await disconnect(f)
	expect((await f.owner.providers(f.project.id, session.id)).selected?.model).toBe(
		'known-selected-model',
	)
})

it('rejects a delayed previous-engine read instead of overwriting the acknowledged selection', async () => {
	const f = await fixture()
	const session = await f.owner.newConversation(f.project.id)
	await writeFile(f.delayedDiscovery, 'harness')
	// The fixture replies to the old discovery only after the following selection ACK.
	const staleRead = f.owner.harnesses(f.project.id, session.id).then(
		(view) => ({ view }),
		(error: unknown) => ({ error }),
	)
	const selection = await f.owner.selectHarness(session.id, 'codex-cli')
	expect(selection.selected).toBe('codex-cli')
	expect(await staleRead).toEqual({
		error: expect.objectContaining({ message: expect.stringContaining('Retry this request') }),
	})
	await rm(f.delayedDiscovery)
	expect((await f.owner.harnesses(f.project.id, session.id)).selected).toBe('codex-cli')
	await disconnect(f)
	expect((await f.owner.harnesses(f.project.id, session.id)).selected).toBe('codex-cli')
})

it('rejects a delayed previous-model read and retains the newly acknowledged model on reconnect', async () => {
	const f = await fixture()
	const session = await f.owner.newConversation(f.project.id)
	await f.owner.selectHarness(session.id, 'codex-cli')
	await writeFile(f.delayedDiscovery, 'provider')
	const staleRead = f.owner.providers(f.project.id, session.id).then(
		(view) => ({ view }),
		(error: unknown) => ({ error }),
	)
	await f.owner.selectProvider(session.id, 'codex-cli', 'newly-selected-model')
	expect(await staleRead).toEqual({
		error: expect.objectContaining({ message: expect.stringContaining('Retry this request') }),
	})
	await rm(f.delayedDiscovery)
	await writeFile(f.defaultModel, 'different-current-default')
	await disconnect(f)
	expect((await f.owner.providers(f.project.id, session.id)).selected).toEqual({
		id: 'codex-cli',
		model: 'newly-selected-model',
	})
})

it('retains failed restoration and retries selection on the same published slot without replaying', async () => {
	const f = await fixture()
	const session = await f.owner.newConversation(f.project.id)
	await f.owner.selectHarness(session.id, 'codex-cli')
	f.owner.saveDraft(session.id, 'Keep this draft on failure')
	const settings = {
		choice: { provider: 'codex-cli', model: 'no-longer-available' },
		options: { permissionMode: 'plan' as const },
	}
	f.owner.saveDraftSettings(session.id, settings)
	await writeFile(f.rejectedSelection, '')
	await disconnect(f)
	const before = await f.calls()
	await expect(f.owner.openConversation(f.project.id, session.id)).resolves.toMatchObject({
		messages: [],
	})
	await expect(f.owner.readyConversation(f.project.id, session.id)).rejects.toThrow(
		'no longer available',
	)
	await expect(f.owner.harnesses(f.project.id, session.id)).rejects.toThrow('no longer available')
	expect(f.owner.draft(session.id)).toBe('Keep this draft on failure')
	expect(f.owner.draftSettings(session.id)).toEqual(settings)
	const failedCalls = (await f.calls()).slice(before.length)
	expect(failedCalls.filter((call) => call.method === 'session/new')).toHaveLength(1)
	expect(failedCalls.filter((call) => call.method === 'session/prompt')).toEqual([])
	await rm(f.rejectedSelection)
	f.owner.saveDraftSettings(session.id, {
		...settings,
		choice: { provider: 'codex-cli', model: 'available-replacement' },
	})
	await f.owner.selectProvider(session.id, 'codex-cli', 'available-replacement')
	expect((await f.owner.providers(f.project.id, session.id)).selected).toEqual({
		id: 'codex-cli',
		model: 'available-replacement',
	})
	const completedCalls = (await f.calls()).slice(before.length)
	expect(completedCalls.filter((call) => call.method === 'session/new')).toHaveLength(1)
	expect(completedCalls.filter((call) => call.method === 'session/prompt')).toEqual([])
})

it('lets an explicit engine change recover a draft whose previous engine model cannot restore', async () => {
	const f = await fixture()
	const session = await f.owner.newConversation(f.project.id)
	await f.owner.selectHarness(session.id, 'codex-cli')
	f.owner.saveDraft(session.id, 'Retained while changing engines')
	await writeFile(f.rejectedSelection, '')
	await disconnect(f)
	await expect(f.owner.openConversation(f.project.id, session.id)).resolves.toMatchObject({
		messages: [],
	})
	await expect(f.owner.readyConversation(f.project.id, session.id)).rejects.toThrow(
		'no longer available',
	)
	expect((await f.owner.selectHarness(session.id, 'claude-code')).selected).toBe('claude-code')
	expect((await f.owner.providers(f.project.id, session.id)).selected?.id).toBe('claude-code')
	expect(f.owner.draft(session.id)).toBe('Retained while changing engines')
})

it('does not restore an external draft into a project whose trust was revoked on reconnect', async () => {
	const f = await fixture()
	const session = await f.owner.newConversation(f.project.id)
	await f.owner.selectHarness(session.id, 'codex-cli')
	f.owner.saveDraft(session.id, 'Trust must still apply')
	await writeFile(f.untrusted, '')
	await disconnect(f)
	const before = await f.calls()
	await expect(f.owner.openConversation(f.project.id, session.id)).resolves.toMatchObject({
		messages: [],
	})
	await expect(f.owner.readyConversation(f.project.id, session.id)).rejects.toThrow(
		'Trust this folder',
	)
	await expect(f.owner.providers(f.project.id, session.id)).rejects.toThrow('Trust this folder')
	expect((await f.calls()).slice(before.length)).toEqual([])
	expect(f.owner.draft(session.id)).toBe('Trust must still apply')
	await f.owner.trust(f.project.id)
	expect((await f.owner.harnesses(f.project.id, session.id)).selected).toBe('codex-cli')
})

it('fences message admission until an explicit replacement engine or model selection settles', async () => {
	const f = await fixture()
	const session = await f.owner.newConversation(f.project.id)
	await f.owner.selectHarness(session.id, 'codex-cli')
	f.owner.saveDraft(session.id, 'Keep this draft during settings changes')
	await disconnect(f)
	const engineSelection = f.owner.selectHarness(session.id, 'namzu')
	expect(() => f.owner.send(session.id, f.owner.draft(session.id))).toThrow('settings change')
	expect((await engineSelection).selected).toBe('namzu')
	await f.owner.selectHarness(session.id, 'claude-code')
	const modelSelection = f.owner.selectProvider(session.id, 'claude-code', 'chosen-model')
	expect(() => f.owner.send(session.id, f.owner.draft(session.id))).toThrow('settings change')
	await modelSelection
	expect((await f.owner.providers(f.project.id, session.id)).selected).toEqual({
		id: 'claude-code',
		model: 'chosen-model',
	})
	expect(f.owner.draft(session.id)).toBe('Keep this draft during settings changes')
	expect(
		(await f.calls()).filter(
			(call) => call.method === 'session/prompt' && call.params.prompt !== 'Break connection',
		),
	).toEqual([])
})

it.each(['prompt', 'plan', 'accept-edits', 'auto', 'strict'] as const)(
	'sends the supported Codex %s mode unchanged to the owned transport',
	async (permissionMode) => {
		const f = await fixture()
		const session = await f.owner.newConversation(f.project.id)
		await f.owner.selectHarness(session.id, 'codex-cli')
		const review = f.wait(
			(event) => event.kind === 'permission' && event.request.sessionId === session.id,
		)
		f.owner.send(session.id, 'An explicit mode', { permissionMode })
		const request = await review
		expect(request.kind).toBe('permission')
		const prompt = (await f.calls()).find((call) => call.method === 'session/prompt')
		expect(prompt?.params.options).toEqual({ permissionMode })
		if (request.kind !== 'permission') throw new Error('Missing permission request')
		const ended = f.wait(
			(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
		)
		f.owner.approve(session.id, request.request.id, false)
		await ended
	},
)
