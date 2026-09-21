/**
 * A namzu home that still holds the old tree starts cleanly, creates a new
 * session, and never opens anything in the old tree (spec C7.7, replaced).
 *
 * There is no migration: the run-era layout (`state/sessions.sqlite`,
 * `sessions/<id>/runs/<id>/run.json`, `titles.json`, UUID-named
 * `projects/<projectId>/sessions/…`, the top-level `checkpoints/`, `goals/`,
 * `memory/<project-id>/` and the rest) may sit beside the new one, and only
 * `namzu state` reports it. The proof is a spy on `node:fs` that records
 * every path an old name reaches while a session starts and runs a turn.
 *
 * The same session pins C7.1 for the CLI: a `session_start` hook receives the
 * session id and no turn id, on stdin and in its environment.
 */

import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider, ProviderRegistry, createUserMessage } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { HooksConfig } from '../../config/schema.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { resolveNamzuHome } from '../../integrations/state/home.js'
import { createAgentSession } from '../agent.js'

const roots: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	for (const root of roots.splice(0)) removeTempDir(root)
})

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'anthropic', model: 'claude-sonnet-5' }],
	subagents: { active: [] },
}
const detected: DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY['anthropic'],
		source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]

const OLD_PROJECT = 'c9e2190e-7298-4132-a0d7-f7d1ebc2341b'
const OLD_TOP_LEVEL = [
	'state',
	'sessions',
	'titles.json',
	'desktop-sessions.json',
	'delegation-history',
	'checkpoints',
	'tenants',
	'goals',
	'feedback',
	'learning',
	'residents',
	'worktrees',
	'memory',
]

/** A full run-era tree under `home`, one file in each place the old layout wrote. */
function plantOldTree(home: string): string[] {
	const write = (path: string, body: string) => {
		mkdirSync(join(path, '..'), { recursive: true })
		writeFileSync(path, body)
	}
	write(join(home, 'state', 'sessions.sqlite'), 'sqlite')
	write(join(home, 'titles.json'), '{}')
	write(join(home, 'desktop-sessions.json'), '{}')
	write(join(home, 'sessions', 'index.json'), '{}')
	write(join(home, 'sessions', 's1', 'runs', 'r1', 'run.json'), '{"id":"r1"}')
	write(join(home, 'sessions', 's1', 'runs', 'r1', 'messages.json'), '[]')
	write(join(home, 'delegation-history', 'h.json'), '{}')
	write(join(home, 'checkpoints', 'x', 'c.json'), '{}')
	write(join(home, 'tenants', 't', 't.json'), '{}')
	write(join(home, 'goals', 'g.json'), '{}')
	write(join(home, 'feedback', 'f.json'), '{}')
	write(join(home, 'learning', 'observations.sqlite'), 'x')
	write(join(home, 'residents', 'a', 'state.json'), '{}')
	write(join(home, 'worktrees', 'w', 'HEAD'), 'ref')
	write(join(home, 'memory', OLD_PROJECT, 'MEMORY.md'), '# m')
	write(join(home, 'projects', OLD_PROJECT, 'sessions', 's1', 'session.json'), '{}')
	write(join(home, 'projects', OLD_PROJECT, 'sessions', 's1', 'runs', 'r1', 'run.json'), '{}')
	return [...OLD_TOP_LEVEL, join('projects', OLD_PROJECT)].map((name) => join(home, name))
}

type FsFunction = (path: unknown, ...rest: unknown[]) => unknown

/**
 * Record every `node:fs` call whose path is inside `roots`. Patches the module
 * object and re-syncs the ESM named exports, so the SDK's own imports see it.
 */
function spyOnPaths(roots: readonly string[]): { hits: string[]; restore: () => void } {
	const hits: string[] = []
	const inOld = (value: unknown): string | undefined => {
		const path =
			value instanceof URL
				? value.pathname
				: Buffer.isBuffer(value)
					? value.toString()
					: typeof value === 'string'
						? value
						: undefined
		return path !== undefined && roots.some((root) => path === root || path.startsWith(`${root}/`))
			? path
			: undefined
	}
	const restores: (() => void)[] = []
	const wrap = (target: Record<string, unknown>, name: string, label: string) => {
		const original = target[name]
		if (typeof original !== 'function') return
		const wrapped = function (this: unknown, path: unknown, ...rest: unknown[]) {
			const hit = inOld(path)
			if (hit) hits.push(`${label} ${hit}`)
			return (original as FsFunction).call(this, path, ...rest)
		}
		Object.assign(wrapped, original)
		target[name] = wrapped
		restores.push(() => {
			target[name] = original
		})
	}
	const sync = [
		'openSync',
		'open',
		'readFileSync',
		'readFile',
		'readdirSync',
		'readdir',
		'statSync',
		'stat',
		'lstatSync',
		'lstat',
		'existsSync',
		'opendirSync',
		'opendir',
		'accessSync',
		'access',
		'realpathSync',
		'watch',
		'createReadStream',
		'createWriteStream',
		'writeFileSync',
		'appendFileSync',
		'mkdirSync',
		'rmSync',
		'unlinkSync',
		'renameSync',
	]
	for (const name of sync) wrap(fs as unknown as Record<string, unknown>, name, name)
	const promised = [
		'open',
		'readFile',
		'readdir',
		'stat',
		'lstat',
		'access',
		'opendir',
		'realpath',
		'writeFile',
		'appendFile',
		'mkdir',
		'rm',
		'unlink',
		'rename',
	]
	for (const name of promised)
		wrap(fs.promises as unknown as Record<string, unknown>, name, `promises.${name}`)
	syncBuiltinESMExports()
	return {
		hits,
		restore: () => {
			for (const undo of restores) undo()
			syncBuiltinESMExports()
		},
	}
}

async function oneTurn(cwd: string, hooks?: HooksConfig): Promise<void> {
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({
		provider: new MockLLMProvider({ turns: [{ text: 'ok' }] }),
	} as never)
	const session = await createAgentSession(preferences, detected, {
		cwd,
		sandbox: { enabled: false },
		...(hooks ? { hooks } : {}),
	})
	try {
		expect(session.hasProvider, session.errorHint ?? undefined).toBe(true)
		for await (const _event of session.send([createUserMessage('hello')])) {
			/* drain */
		}
	} finally {
		await session.close()
	}
}

it('starts, creates a session and runs a turn without opening the old tree', async () => {
	const home = resolveNamzuHome()
	const old = plantOldTree(home)
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-old-tree-cwd-'))
	roots.push(cwd)

	const spy = spyOnPaths(old)
	try {
		// The spy is live: an old path read on purpose is recorded.
		existsSync(join(home, 'titles.json'))
		expect(spy.hits).toEqual([`existsSync ${join(home, 'titles.json')}`])
		spy.hits.length = 0

		await oneTurn(cwd)
	} finally {
		spy.restore()
	}

	expect(spy.hits).toEqual([])
	// And the turn did land: in the new layout, beside the old tree.
	const projects = fs.readdirSync(join(home, 'projects'))
	expect(projects.some((name) => name !== OLD_PROJECT && name.startsWith('-'))).toBe(true)
})

it('gives a session_start hook the session id and no turn id', async () => {
	const out = await mkdtemp(join(tmpdir(), 'namzu-session-start-hook-'))
	roots.push(out)
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-session-start-cwd-'))
	roots.push(cwd)
	const stdin = join(out, 'stdin.json')
	const env = join(out, 'env.txt')

	await oneTurn(cwd, {
		session_start: [{ command: `cat > '${stdin}'; env | grep '^NAMZU_' > '${env}'` }],
	} as HooksConfig)

	const payload = JSON.parse(readFileSync(stdin, 'utf8')) as Record<string, unknown>
	expect(payload.event).toBe('session_start')
	expect(typeof payload.session_id).toBe('string')
	expect(payload).not.toHaveProperty('turn_id')
	const variables = readFileSync(env, 'utf8')
	expect(variables).toMatch(/^NAMZU_SESSION_ID=/m)
	expect(variables).not.toMatch(/^NAMZU_TURN_ID=/m)
	expect(variables).toMatch(/^NAMZU_HOOK_EVENT=session_start$/m)
})
