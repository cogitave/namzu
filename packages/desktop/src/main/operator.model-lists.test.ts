import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopEvent } from '../shared/protocol.js'
import { Operator } from './operator.js'

const directories: string[] = []
const owners: Operator[] = []
const HOUR = 60 * 60 * 1000
beforeEach(() => {
	// Only the clock is faked: the child process and its pipes keep running on real I/O.
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date('2026-10-08T09:00:00.000Z'))
})
afterEach(async () => {
	vi.useRealTimers()
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-model-lists-'))
	directories.push(root)
	const log = join(root, 'requests.jsonl')
	const modelsFile = join(root, 'models')
	const rejectSelection = join(root, 'reject-selection')
	const metadata = join(root, 'metadata')
	const events: DesktopEvent[] = []
	const diagnostics: { event: string; operation?: string }[] = []
	const open = () => {
		const owner = new Operator(
			{
				program: process.execPath,
				args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
				env: {
					...process.env,
					FIXTURE_REQUEST_LOG: log,
					FIXTURE_LIST_PROVIDER: 'Fixture provider',
					FIXTURE_MODELS_FILE: modelsFile,
					FIXTURE_REJECT_SELECTION_FILE: rejectSelection,
					FIXTURE_REJECT_METADATA_FILE: metadata,
				},
			},
			(event) => events.push(event),
			root,
			{ record: (event, context) => diagnostics.push({ event, operation: context?.operation }) },
		)
		owners.push(owner)
		return owner
	}
	const list = (...ids: string[]) =>
		writeFile(modelsFile, JSON.stringify(ids.map((id) => ({ id, label: id.toUpperCase() }))))
	const reads = async () =>
		(await readFile(log, 'utf8').catch(() => ''))
			.split('\n')
			.filter((line) => line.includes('"namzu/providers/models"')).length
	const updates = () => events.filter((event) => event.kind === 'model-catalogue-updated')
	return {
		root,
		open,
		list,
		reads,
		updates,
		events,
		diagnostics,
		modelsFile,
		rejectSelection,
		metadata,
	}
}

/** A previous app run that stored `ids`; the next `f.open()` is a fresh launch. */
async function seed(f: Awaited<ReturnType<typeof setup>>, ...ids: string[]) {
	await f.list(...ids)
	const earlier = f.open()
	await earlier.models((await project(earlier)).id, 'fixture')
	await earlier.close()
}

async function project(owner: Operator) {
	const view = await owner.openProject(process.cwd())
	await owner.providers(view.id)
	return view
}

it('reads an unstored provider once, awaited, and keeps the list for the next open', async () => {
	const f = await setup()
	await f.list('alpha', 'beta')
	const owner = f.open()
	const view = await project(owner)
	const first = await owner.models(view.id, 'fixture')
	expect(first.models.map((model) => model.id)).toEqual(['alpha', 'beta'])
	expect(first.fetchedAt).toBe(Date.now())
	expect(first.models.every((model) => model.firstSeen === undefined)).toBe(true)
	// That read already served this launch, so opening again asks the CLI nothing.
	await owner.models(view.id, 'fixture')
	await owner.modelReadsSettled()
	expect(await f.reads()).toBe(1)
	expect(f.updates()).toEqual([])
	const file = JSON.parse(await readFile(join(f.root, 'model-lists.json'), 'utf8'))
	expect(file.version).toBe(1)
	expect(Object.keys(file.entries)).toHaveLength(1)
})

it('answers from the store at once and revalidates in the background once per launch', async () => {
	const f = await setup()
	await seed(f, 'alpha')
	const owner = f.open()
	const view = await project(owner)
	// Opens made before the background read settles start one read between them.
	await owner.models(view.id, 'fixture')
	await owner.models(view.id, 'fixture')
	await owner.models(view.id, 'fixture')
	await owner.modelReadsSettled()
	expect(await f.reads()).toBe(2)
	await owner.models(view.id, 'fixture')
	await owner.modelReadsSettled()
	expect(await f.reads()).toBe(2)
})

it('returns the stored rows when the source fails and records a diagnostics line', async () => {
	const f = await setup()
	await seed(f, 'alpha')
	await writeFile(f.modelsFile, 'throw')
	const owner = f.open()
	const view = await project(owner)
	const stored = await owner.models(view.id, 'fixture')
	expect(stored.models.map((model) => model.id)).toEqual(['alpha'])
	await owner.modelReadsSettled()
	expect(f.diagnostics).toContainEqual({ event: 'cli_request_failed', operation: 'models' })
	expect(f.updates()).toEqual([])
	expect((await owner.models(view.id, 'fixture')).models.map((model) => model.id)).toEqual([
		'alpha',
	])
})

it('keeps the stored rows when a refresh comes back as a failed listing', async () => {
	const f = await setup()
	await seed(f, 'alpha')
	await writeFile(f.modelsFile, 'empty')
	const owner = f.open()
	const view = await project(owner)
	await owner.models(view.id, 'fixture')
	await owner.modelReadsSettled()
	expect(f.updates()).toEqual([])
	expect(f.diagnostics).toContainEqual({ event: 'cli_request_failed', operation: 'models' })
	const after = await owner.models(view.id, 'fixture')
	expect(after.models.map((model) => model.id)).toEqual(['alpha'])
	expect(after.notice).toBeNull()
})

it('announces a changed list once and marks the added model as first seen now', async () => {
	const f = await setup()
	await seed(f, 'alpha')
	await f.list('alpha', 'beta')
	const owner = f.open()
	const view = await project(owner)
	const stale = await owner.models(view.id, 'fixture')
	expect(stale.models.map((model) => model.id)).toEqual(['alpha'])
	await owner.modelReadsSettled()
	expect(f.updates()).toEqual([
		{ kind: 'model-catalogue-updated', engine: 'namzu', provider: 'fixture' },
	])
	const fresh = await owner.models(view.id, 'fixture')
	expect(fresh.models).toEqual([
		{ id: 'alpha', label: 'ALPHA' },
		{ id: 'beta', label: 'BETA', firstSeen: '2026-10-08T09:00:00.000Z' },
	])
	await owner.modelReadsSettled()
	expect(f.updates()).toHaveLength(1)
})

it('stays quiet when the refresh returns the same rows', async () => {
	const f = await setup()
	await seed(f, 'alpha', 'beta')
	const owner = f.open()
	const view = await project(owner)
	await owner.models(view.id, 'fixture')
	await owner.modelReadsSettled()
	expect(await f.reads()).toBe(2)
	expect(f.updates()).toEqual([])
})

it('revalidates a stored list older than six hours, and not before', async () => {
	const f = await setup()
	await seed(f, 'alpha')
	const owner = f.open()
	const view = await project(owner)
	await owner.models(view.id, 'fixture')
	await owner.modelReadsSettled()
	expect(await f.reads()).toBe(2)
	vi.setSystemTime(Date.now() + 6 * HOUR - 1)
	await owner.models(view.id, 'fixture')
	await owner.modelReadsSettled()
	expect(await f.reads()).toBe(2)
	vi.setSystemTime(Date.now() + 2)
	await owner.models(view.id, 'fixture')
	await owner.modelReadsSettled()
	expect(await f.reads()).toBe(3)
})

it('shares one stored list across conversations of the same provider', async () => {
	const f = await setup()
	await seed(f, 'alpha')
	const owner = f.open()
	const view = await project(owner)
	const a = await owner.newConversation(view.id)
	const b = await owner.newConversation(view.id)
	await owner.providers(view.id, a.id)
	await owner.providers(view.id, b.id)
	await owner.models(view.id, 'fixture', a.id)
	const second = await owner.models(view.id, 'fixture', b.id)
	await owner.modelReadsSettled()
	expect(second.models.map((model) => model.id)).toEqual(['alpha'])
	// One seed read plus the launch's single revalidation, whichever conversation asked first.
	expect(await f.reads()).toBe(2)
})

it('revalidates after the CLI refuses a model the list offered', async () => {
	const f = await setup()
	await seed(f, 'alpha')
	const owner = f.open()
	const view = await project(owner)
	const conversation = await owner.newConversation(view.id)
	await owner.providers(view.id, conversation.id)
	await owner.models(view.id, 'fixture', conversation.id)
	await owner.modelReadsSettled()
	expect(await f.reads()).toBe(2)
	await writeFile(f.rejectSelection, '1')
	await expect(owner.selectProvider(conversation.id, 'fixture', 'alpha')).rejects.toThrow()
	await owner.models(view.id, 'fixture', conversation.id)
	await owner.modelReadsSettled()
	expect(await f.reads()).toBe(3)
})

it('never stores a failed listing', async () => {
	const f = await setup()
	await writeFile(f.modelsFile, 'empty')
	const owner = f.open()
	const view = await project(owner)
	const shown = await owner.models(view.id, 'fixture')
	expect(shown.models).toEqual([])
	expect(shown.notice).toContain('could not be loaded')
	await f.list('alpha')
	expect((await owner.models(view.id, 'fixture')).models.map((model) => model.id)).toEqual([
		'alpha',
	])
	expect(await f.reads()).toBe(2)
})

it('drops a stored list when its provider leaves the status, so a new sign-in is never shown it', async () => {
	const f = await setup()
	await seed(f, 'alpha')
	const owner = f.open()
	const view = await project(owner)
	await owner.models(view.id, 'fixture')
	await owner.modelReadsSettled()
	// The provider signs out: the status no longer lists it.
	await writeFile(f.metadata, 'empty')
	await owner.providers(view.id)
	const file = JSON.parse(await readFile(join(f.root, 'model-lists.json'), 'utf8'))
	expect(Object.keys(file.entries)).toEqual([])
	// Another account signs in: its list is read, not the earlier account's.
	await rm(f.metadata)
	await f.list('gamma')
	await owner.providers(view.id)
	const next = await owner.models(view.id, 'fixture')
	expect(next.models.map((model) => model.id)).toEqual(['gamma'])
})

it('tries a failing source again after a minute, not on every open', async () => {
	const f = await setup()
	await seed(f, 'alpha')
	await writeFile(f.modelsFile, 'empty')
	const owner = f.open()
	const view = await project(owner)
	await owner.models(view.id, 'fixture')
	await owner.modelReadsSettled()
	expect(await f.reads()).toBe(2)
	await owner.models(view.id, 'fixture')
	await owner.modelReadsSettled()
	expect(await f.reads()).toBe(2)
	vi.setSystemTime(Date.now() + 61 * 1000)
	await f.list('alpha', 'beta')
	await owner.models(view.id, 'fixture')
	await owner.modelReadsSettled()
	expect(await f.reads()).toBe(3)
	expect(f.updates()).toHaveLength(1)
})
