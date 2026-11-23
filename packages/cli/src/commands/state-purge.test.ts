import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureProject } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import type { PurgeSeams } from '../integrations/state/purge.js'
import type { Formatter } from '../output/index.js'
import { createStateCommand } from './state.js'

const dirs: string[] = []

function temp(label: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `namzu-purge-${label}-`)))
	dirs.push(dir)
	return dir
}

afterEach(() => {
	dirs.length = 0
})

interface World {
	home: string
	folder: string
	slug: string
}

async function world(label: string, folderName = 'app'): Promise<World> {
	const root = temp(label)
	const home = join(root, 'home')
	const folder = join(root, folderName)
	mkdirSync(home, { recursive: true })
	mkdirSync(folder, { recursive: true })
	writeFileSync(join(folder, 'settings.local.json'), '{"keep":true}\n')
	const project = await ensureProject({ home, cwd: folder })
	const dir = join(home, 'projects', project.slug)
	mkdirSync(join(dir, 'sess1', 'file-history'), { recursive: true })
	mkdirSync(join(dir, 'sess1', 'plans'), { recursive: true })
	writeFileSync(join(dir, 'sess1.jsonl'), '{}\n')
	writeFileSync(join(dir, 'sess1', 'plans', 'plan.md'), 'plan\n')
	mkdirSync(join(home, 'backups', 'projects', project.slug), { recursive: true })
	writeFileSync(join(home, 'backups', 'projects', project.slug, 'x.backup.1'), 'b\n')
	mkdirSync(join(home, 'memory-inbox'), { recursive: true })
	writeFileSync(join(home, 'memory-inbox', `${project.slug}.jsonl`), '{}\n')
	return { home, folder, slug: project.slug }
}

function history(home: string, lines: readonly { project: string; display: string }[]): void {
	writeFileSync(
		join(home, 'history.jsonl'),
		lines
			.map((l, i) => `${JSON.stringify({ ...l, sessionId: 's', timestamp: 1000 + i })}\n`)
			.join(''),
	)
}

function run(
	w: { home: string; folder: string },
	args: string[],
	extra: {
		terminal?: boolean
		answer?: boolean
		seams?: PurgeSeams
		beforeAnswer?: () => void
	} = {},
) {
	const printed: string[] = []
	const errors: string[] = []
	const asked: string[] = []
	const formatter: Formatter = {
		name: 'text',
		print: (p) => printed.push(String((p as { text?: string }).text ?? '')),
		info: () => undefined,
		error: (p) => errors.push(String((p as { message?: string }).message ?? '')),
	}
	const command = createStateCommand({
		inspect: async () => {
			throw new Error('not used')
		},
		purge: {
			cwd: () => w.folder,
			home: () => w.home,
			isTerminal: () => extra.terminal ?? false,
			confirm: async (q) => {
				asked.push(q)
				extra.beforeAnswer?.()
				return extra.answer ?? false
			},
			seams: extra.seams,
		},
	})
	return {
		printed,
		errors,
		asked,
		code: command.handler({ ctx: { config: {}, formatter }, rawArgs: ['purge', ...args] }),
	}
}

const quiet: PurgeSeams = { isProcessAlive: () => false }

describe('namzu state purge', () => {
	it('deletes what is kept for the project, only its prompts, and nothing in the folder', async () => {
		const w = await world('basic')
		const other = await world('other')
		history(w.home, [
			{ project: w.folder, display: 'mine' },
			{ project: '/somewhere/else', display: 'theirs' },
		])
		// A second project in the same home must stay.
		const second = await ensureProject({ home: w.home, cwd: other.folder })
		mkdirSync(join(w.home, 'projects', second.slug, 's2'), { recursive: true })

		const r = run(w, ['--yes'], { seams: quiet })
		expect(await r.code).toBe(0)

		expect(existsSync(join(w.home, 'projects', w.slug))).toBe(false)
		expect(existsSync(join(w.home, 'backups', 'projects', w.slug))).toBe(false)
		expect(existsSync(join(w.home, 'memory-inbox', `${w.slug}.jsonl`))).toBe(false)
		expect(readFileSync(join(w.home, 'history.jsonl'), 'utf8')).toContain('theirs')
		expect(readFileSync(join(w.home, 'history.jsonl'), 'utf8')).not.toContain('mine')
		expect(existsSync(join(w.home, 'projects', second.slug, 's2'))).toBe(true)
		expect(readFileSync(join(w.folder, 'settings.local.json'), 'utf8')).toBe('{"keep":true}\n')
	})

	it('lists and deletes nothing with --dry-run, even with no terminal', async () => {
		const w = await world('dry')
		const r = run(w, ['--dry-run'], { seams: quiet })
		expect(await r.code).toBe(0)
		expect(r.printed.join('\n')).toContain('Would delete')
		expect(existsSync(join(w.home, 'projects', w.slug, 'sess1.jsonl'))).toBe(true)
	})

	it('refuses with one line, exit 64, when there is no terminal and no --yes', async () => {
		const w = await world('noterm')
		const r = run(w, [], { seams: quiet })
		expect(await r.code).toBe(64)
		expect(r.errors).toHaveLength(1)
		expect(existsSync(join(w.home, 'projects', w.slug, 'sess1.jsonl'))).toBe(true)
	})

	it('asks on a terminal and deletes only on a yes', async () => {
		const w = await world('ask')
		const no = run(w, [], { terminal: true, answer: false, seams: quiet })
		expect(await no.code).toBe(0)
		expect(no.asked).toHaveLength(1)
		expect(existsSync(join(w.home, 'projects', w.slug, 'sess1.jsonl'))).toBe(true)
		const yes = run(w, [], { terminal: true, answer: true, seams: quiet })
		expect(await yes.code).toBe(0)
		expect(existsSync(join(w.home, 'projects', w.slug))).toBe(false)
	})

	it('leaves a project alone while a session of it holds its lease', async () => {
		const w = await world('live')
		writeFileSync(
			join(w.home, 'projects', w.slug, 'sess1', 'lease.1.json'),
			JSON.stringify({ holder: 'someone', expiresAt: Date.now() + 3_600_000 }),
		)
		const r = run(w, ['--yes'], { seams: { isProcessAlive: () => true } })
		expect(await r.code).toBe(1)
		expect(r.printed.join('\n')).toContain('is running')
		expect(existsSync(join(w.home, 'projects', w.slug, 'sess1.jsonl'))).toBe(true)
	})

	it('leaves a project alone when a session starts while the prompt is open', async () => {
		const w = await world('late')
		const r = run(w, [], {
			terminal: true,
			answer: true,
			seams: { isProcessAlive: () => true },
			beforeAnswer: () =>
				writeFileSync(
					join(w.home, 'projects', w.slug, 'sess1', 'lease.1.json'),
					JSON.stringify({ holder: 'someone', expiresAt: Date.now() + 3_600_000 }),
				),
		})
		expect(await r.code).toBe(1)
		expect(r.printed.join('\n')).toContain('left alone')
		expect(existsSync(join(w.home, 'projects', w.slug, 'sess1.jsonl'))).toBe(true)
	})

	it('leaves a project alone while its git worktrees are still there', async () => {
		const w = await world('trees')
		mkdirSync(join(w.home, 'projects', w.slug, 'worktrees', 'feature'), { recursive: true })
		const r = run(w, ['--yes'], { seams: quiet })
		expect(await r.code).toBe(1)
		expect(existsSync(join(w.home, 'projects', w.slug, 'worktrees', 'feature'))).toBe(true)
	})

	it('does not follow a link out of the Namzu home', async () => {
		const w = await world('link')
		const outside = temp('outside')
		writeFileSync(join(outside, 'precious.txt'), 'keep\n')
		// The project's backups folder becomes a link to a folder outside the home.
		const backups = join(w.home, 'backups', 'projects', w.slug)
		const { rmSync } = await import('node:fs')
		rmSync(backups, { recursive: true })
		symlinkSync(outside, backups)
		const r = run(w, ['--yes'], { seams: quiet })
		expect(await r.code).toBe(1)
		expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep\n')
		expect(existsSync(join(w.home, 'projects', w.slug, 'sess1.jsonl'))).toBe(true)
	})

	it('does not follow a linked projects folder', async () => {
		const w = await world('linkprojects')
		const outside = temp('outside2')
		const real = join(w.home, 'projects')
		const { renameSync } = await import('node:fs')
		renameSync(real, join(outside, 'projects'))
		symlinkSync(join(outside, 'projects'), real)
		const r = run(w, ['--yes'], { seams: quiet })
		expect(await r.code).toBe(1)
		expect(existsSync(join(outside, 'projects', w.slug, 'sess1.jsonl'))).toBe(true)
	})

	it('--all purges every project and every prompt, under the same confirmation rule', async () => {
		const a = await world('all')
		const b = await world('all2')
		const second = await ensureProject({ home: a.home, cwd: b.folder })
		mkdirSync(join(a.home, 'projects', second.slug, 's2'), { recursive: true })
		history(a.home, [
			{ project: a.folder, display: 'one' },
			{ project: '/x', display: 'two' },
		])
		const refused = run(a, ['--all'], { seams: quiet })
		expect(await refused.code).toBe(64)
		const r = run(a, ['--all', '--yes'], { seams: quiet })
		expect(await r.code).toBe(0)
		expect(existsSync(join(a.home, 'projects', a.slug))).toBe(false)
		expect(existsSync(join(a.home, 'projects', second.slug))).toBe(false)
		expect(readFileSync(join(a.home, 'history.jsonl'), 'utf8')).toBe('')
	})

	it('removes the project from the session index', async () => {
		const w = await world('index')
		const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
			DatabaseSync: new (
				p: string,
			) => {
				exec(s: string): void
				prepare(s: string): { all(...a: unknown[]): unknown[] }
				close(): void
			}
		}
		const file = join(w.home, 'index.sqlite')
		const db = new DatabaseSync(file)
		db.exec(`CREATE TABLE projects (slug TEXT, project_id TEXT, cwd TEXT);
CREATE TABLE sessions (id TEXT, slug TEXT);
CREATE TABLE turns (session_id TEXT); CREATE TABLE pending_decisions (session_id TEXT);
CREATE TABLE external_refs (session_id TEXT); CREATE TABLE children (session_id TEXT);
CREATE TABLE batches (session_id TEXT); CREATE TABLE evidence_fts (session_id TEXT);
INSERT INTO projects VALUES ('${w.slug}', 'p', '/a'), ('other', 'q', '/b');
INSERT INTO sessions VALUES ('s1', '${w.slug}'), ('s2', 'other');
INSERT INTO turns VALUES ('s1'), ('s2');`)
		db.close()
		const r = run(w, ['--yes'], { seams: quiet })
		expect(await r.code).toBe(0)
		const after = new DatabaseSync(file)
		expect(after.prepare('SELECT slug FROM projects').all()).toEqual([{ slug: 'other' }])
		expect(after.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 's2' }])
		expect(after.prepare('SELECT session_id FROM turns').all()).toEqual([{ session_id: 's2' }])
		after.close()
	})

	it('says so when nothing is kept, and rejects unknown flags and a path with --all', async () => {
		const w = await world('none')
		const empty = temp('empty')
		const folder = temp('nofolder')
		const r = run({ home: empty, folder }, ['--yes'], { seams: quiet })
		expect(await r.code).toBe(0)
		expect(r.printed.join('\n')).toContain('Nothing is kept')
		expect(await run(w, ['--bogus']).code).toBe(64)
		expect(await run(w, ['--all', 'x', '--yes']).code).toBe(64)
	})
})
