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
	const root = await mkdtemp(join(tmpdir(), 'namzu-desktop-hooks-'))
	directories.push(root)
	const log = join(root, 'requests.ndjson')
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: { ...process.env, FIXTURE_REQUEST_LOG: log, ...env },
		},
		() => {},
		root,
	)
	owners.push(owner)
	const project = await owner.openProject(process.cwd())
	const requests = async () =>
		(await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> })
	return { owner, project, requests }
}

const ANSWER = {
	version: 1,
	folder: { path: '/work/app', trusted: true },
	switches: {
		disableHooks: { on: false },
		hooksManagedOnly: { on: false },
		plugins: { on: true },
	},
	hooks: [
		{
			id: 'h1',
			event: 'pre_tool_use',
			type: 'http',
			runs: 'POST https://u:pw@hooks.example/x?token=SECRETQ',
			headers: { Authorization: 'Bearer SECRETH' },
			env: { API_TOKEN: 'SECRETE' },
			origin: { kind: 'config', label: '/work/app/namzu.config.json', scope: 'project' },
			state: 'runs',
		},
		{ id: 'bad' },
	],
	modules: [],
	problems: [],
	counts: { runs: 1, off: 0, attachesWhenUsed: 0, notLoaded: 0, waitingForTrust: 0, problems: 0 },
}

it('hands on the engine’s answer for the project, read through the reader that keeps nothing it does not know', async () => {
	const { owner, project, requests } = await setup({ FIXTURE_HOOKS: JSON.stringify(ANSWER) })
	const view = await owner.hooksView(project.id)
	expect(view?.own).toBe(false)
	expect(view?.report.hooks.map((hook) => hook.id)).toEqual(['h1'])
	expect(view?.report.unreadable).toBe(1)
	expect(JSON.stringify(view)).not.toMatch(/SECRET|pw@/)
	const asked = (await requests()).filter((request) => request.method === 'namzu/hooks/list')
	expect(asked).toHaveLength(1)
	expect(asked[0]?.params).toEqual({})
})

it('asks the person’s own host when no project is given, and calls the answer their own', async () => {
	const { owner, requests } = await setup({ FIXTURE_HOOKS: JSON.stringify(ANSWER) })
	const view = await owner.hooksView()
	expect(view?.own).toBe(true)
	expect((await requests()).some((request) => request.method === 'namzu/hooks/list')).toBe(true)
})

it('says nothing when the engine does not know the question, and asks nothing', async () => {
	const { owner, project, requests } = await setup()
	expect(await owner.hooksView(project.id)).toBeNull()
	expect(await owner.hooksView()).toBeNull()
	expect((await requests()).some((request) => request.method === 'namzu/hooks/list')).toBe(false)
})

it('refuses an answer it cannot read instead of showing an empty list', async () => {
	const { owner, project } = await setup({ FIXTURE_HOOKS: JSON.stringify({ nonsense: true }) })
	await expect(owner.hooksView(project.id)).rejects.toThrow('cannot read')
})
