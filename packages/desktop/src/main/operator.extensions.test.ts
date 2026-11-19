import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

async function setup(env: NodeJS.ProcessEnv = {}) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-desktop-extensions-'))
	directories.push(root)
	const log = join(root, 'requests.ndjson')
	const events: { kind: string }[] = []
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: { ...process.env, FIXTURE_REQUEST_LOG: log, ...env },
		},
		(event) => events.push(event),
		root,
	)
	owners.push(owner)
	const requests = async () =>
		(await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> })
	return { owner, events, requests }
}

const LIST = {
	extensions: [{ id: 'com.example.stub', name: 'Stub', version: '1.0.0', state: 'added' }],
}

it('hands a method of the page to the engine and returns what it answered', async () => {
	const { owner, requests } = await setup({ FIXTURE_EXTENSIONS: JSON.stringify(LIST) })
	expect(await owner.extensions('namzu/extensions/list')).toEqual(LIST)
	expect(
		await owner.extensions('namzu/extensions/notice', { id: 'com.example.stub', staged: true }),
	).toEqual({
		echo: 'namzu/extensions/notice',
		params: { id: 'com.example.stub', staged: true },
	})
	const asked = (await requests()).filter((r) => r.method.startsWith('namzu/extensions/'))
	expect(asked.map((r) => r.method)).toEqual(['namzu/extensions/list', 'namzu/extensions/notice'])
})

it('answers null, and asks nothing, when the engine does not offer extensions', async () => {
	const { owner, requests } = await setup()
	expect(await owner.extensions('namzu/extensions/list')).toBeNull()
	expect(
		(await requests().catch(() => [])).some((r) => r.method.startsWith('namzu/extensions/')),
	).toBe(false)
})

it('refuses a method that is not the page’s and parameters that are not an object', async () => {
	const { owner } = await setup({ FIXTURE_EXTENSIONS: JSON.stringify(LIST) })
	await expect(owner.extensions('namzu/project/trust')).rejects.toThrow(/not an extensions method/)
	await expect(owner.extensions('session/prompt')).rejects.toThrow(/not an extensions method/)
	await expect(owner.extensions(5)).rejects.toThrow(/not an extensions method/)
	await expect(owner.extensions('namzu/extensions/list', ['x'])).rejects.toThrow(
		/Invalid extensions parameters/,
	)
})

it('turns the engine’s state notification into an event for the window, reading only what it knows', async () => {
	const { owner, events } = await setup({ FIXTURE_EXTENSIONS: JSON.stringify(LIST) })
	await owner.extensions('namzu/extensions/enable', { id: 'com.example.stub' })
	await new Promise<void>((resolve) => {
		const check = () =>
			events.some((e) => e.kind === 'extensions-state') ? resolve() : setImmediate(check)
		check()
	})
	const event = events.find((e) => e.kind === 'extensions-state') as unknown as Record<
		string,
		unknown
	>
	expect(event).toMatchObject({
		id: 'com.example.stub',
		state: 'running',
		indicator: { level: 'ok', label: 'Recorder is counting.' },
	})
})
