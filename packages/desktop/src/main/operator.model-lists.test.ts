import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopEvent } from '../shared/protocol.js'
import { ModelListStore, modelListKey } from './model-list-store.js'
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
	const contexts: { event: string; context: Record<string, unknown> }[] = []
	const identity = join(root, 'identity')
	const open = (extraEnv: Record<string, string> = {}) => {
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
					FIXTURE_IDENTITY_FILE: identity,
					...extraEnv,
				},
			},
			(event) => events.push(event),
			root,
			{
				record: (event, context) => {
					diagnostics.push({ event, operation: context?.operation })
					contexts.push({ event, context: { ...context } })
				},
			},
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
		contexts,
		modelsFile,
		rejectSelection,
		metadata,
		identity,
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

it('keys a stored list by the installed engine build, so an upgrade drops the old list at once', async () => {
	const f = await setup()
	await writeFile(f.identity, 'build-a')
	await seed(f, 'alpha')
	await f.list('alpha', 'beta')
	await writeFile(f.identity, 'build-b')
	const owner = f.open()
	const view = await project(owner)
	// Nothing stored under the new build: the read is awaited, never the old build's rows.
	const first = await owner.models(view.id, 'fixture')
	expect(first.models.map((model) => model.id)).toEqual(['alpha', 'beta'])
	expect(first.fetchedAt).toBe(Date.now())
	const file = JSON.parse(await readFile(join(f.root, 'model-lists.json'), 'utf8'))
	expect(Object.keys(file.entries)).toHaveLength(1)
})

it('keeps serving the stored list while the same build is unchanged', async () => {
	const f = await setup()
	await writeFile(f.identity, 'build-a')
	await seed(f, 'alpha')
	const owner = f.open()
	const view = await project(owner)
	await f.list('alpha', 'beta')
	const stored = await owner.models(view.id, 'fixture')
	expect(stored.models.map((model) => model.id)).toEqual(['alpha'])
	await owner.modelReadsSettled()
})

it('records what an engine start cost, from the CLI, as a diagnostics line without paths', async () => {
	const f = await setup()
	await f.list('alpha')
	const timings = [
		{
			engine: 'codex-cli',
			operation: 'models',
			timings: { spawnMs: 41, initializeMs: 93, modelListMs: 12, totalMs: 160 },
		},
	]
	const owner = f.open({ FIXTURE_TIMINGS: JSON.stringify(timings) })
	const view = await project(owner)
	await owner.models(view.id, 'fixture')
	const lines = f.contexts.filter((line) => line.event === 'engine_timing')
	expect(lines).toHaveLength(1)
	expect(lines[0]?.context).toMatchObject({
		engineId: 'codex-cli',
		step: 'models',
		timings: { spawnMs: 41, initializeMs: 93, modelListMs: 12, totalMs: 160 },
	})
})

it('drops every stored list of an engine whose program was updated, and tells open pickers', async () => {
	const f = await setup()
	const build = (identity: string) =>
		modelListKey({ engine: 'codex-cli', id: 'codex-cli', label: 'Codex CLI', identity })
	const zen = modelListKey({ engine: 'namzu', id: 'fixture', label: 'Fixture provider' })
	const store = new ModelListStore(f.root)
	store.put(build('old'), { models: [{ id: 'gpt-old', label: 'Old' }], notice: null })
	store.put(zen, { models: [{ id: 'alpha', label: 'Alpha' }], notice: null })
	const owner = f.open()
	owner.engineUpdated('codex-cli')
	expect(f.updates()).toEqual([
		{ kind: 'model-catalogue-updated', engine: 'codex-cli', provider: 'codex-cli' },
	])
	const file = JSON.parse(await readFile(join(f.root, 'model-lists.json'), 'utf8'))
	expect(Object.keys(file.entries)).toEqual([zen])
})

it('asks each ready project’s runtime to end its idle servers for the engine', async () => {
	const f = await setup()
	const owner = f.open()
	await project(owner)
	await expect(owner.releaseEngine('codex-cli')).resolves.toBeUndefined()
	const log = await readFile(join(f.root, 'requests.jsonl'), 'utf8')
	const release = log.split('\n').filter((line) => line.includes('"namzu/harnesses/release"'))
	expect(release).toHaveLength(1)
	expect(release[0]).toContain('"engine":"codex-cli"')
})

it('is busy for an engine only while a conversation on that engine has work', async () => {
	const f = await setup()
	const owner = f.open()
	expect(owner.engineBusy('codex-cli')).toBe(false)
	expect(owner.engineBusy('claude-code')).toBe(false)
})
