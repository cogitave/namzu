/**
 * State an earlier Namzu kept inside a project's own `.namzu/` folder.
 *
 * Before state moved to the Namzu home (2026-09-01), a project's sessions lived
 * in `<project>/.namzu` (a `cli.json` pointer and `projects/<id>/…`), and before
 * session logs the whole layout did (`sessions/`, `checkpoints/`, `worktrees/`,
 * `state/` …). This version neither reads nor writes any of it there: the
 * folder holds only what a person authors. Left in place it sits in the
 * checkout, where `git add .` can pick it up.
 *
 * This module names that state for `namzu state`, keeps git from listing it in
 * this clone (`excludeProjectLegacy`, a block in the clone's `info/exclude`,
 * never the committed `.gitignore`), and moves it into
 * `<Namzu home>/legacy/<slug>/<time>/` when the person asks
 * (`moveProjectLegacyState`). Only names an earlier Namzu wrote are touched;
 * anything else in the folder is the person's and stays. A move never removes
 * anything before its new copy is in place: a rename on one file system, or a
 * copy that is flushed, renamed into place and compared file by file with the
 * original before the original is removed. Whatever git tracks, a registered
 * git worktree that has changes or is locked, and anything that cannot be
 * checked stay where they are, with the reason.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createReadStream, existsSync } from 'node:fs'
import {
	appendFile,
	copyFile,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	readlink,
	realpath,
	rename,
	rm,
	rmdir,
	symlink,
	unlink,
	writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { slugForCwd } from '@namzu/sdk'

import { isTrustedAtStateRoot } from '../trust/store.js'
import { cliProjectRoot } from './project.js'

/** What a person authors in a project's `.namzu/`, which this version reads. Never legacy. */
export const PROJECT_AUTHORED_NAMES: ReadonlySet<string> = new Set([
	'agents',
	'commands',
	'plugins',
	'skills',
	'rules',
	'MEMORY.md',
	// A Pal workspace's imported reference pictures.
	'reference-imports',
])

/** The project's settings files in `.namzu/` (configuration, not legacy). */
export const PROJECT_SETTINGS_NAMES: ReadonlySet<string> = new Set([
	'settings.json',
	'settings.local.json',
])

/**
 * Top-level names an earlier Namzu wrote in a project's `.namzu/`. Only these
 * are ever moved or ignored: a name no version wrote is the person's own.
 */
export const PROJECT_LEGACY_NAMES: ReadonlySet<string> = new Set([
	// The layout before session logs.
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
	// The project-local layout before state moved to the Namzu home.
	'cli.json',
	'cli',
	'projects',
	'attachments',
	'index.sqlite',
	'index.sqlite-journal',
	'index.sqlite-wal',
	'index.sqlite-shm',
	// Per-machine files kept beside them while the folder served as the home.
	'config.yaml',
	'credentials.json',
	'identity.json',
	'preferences.json',
	'plugin-settings',
	'trust.json',
])

/** The Namzu home folder that receives moved state: `legacy/<slug>/<time>/`. */
export function projectLegacyDestination(home: string, cwd: string): string {
	return join(home, 'legacy', slugForCwd(cwd))
}

export interface ProjectLegacyEntry {
	readonly name: string
	readonly kind: 'directory' | 'file' | 'symlink' | 'other'
}

/** The legacy names at the top of `<cwd>/.namzu`, sorted; none when the folder is not a real one. */
export async function findProjectLegacy(cwd: string): Promise<ProjectLegacyEntry[]> {
	const root = join(cwd, '.namzu')
	try {
		const entry = await lstat(root)
		if (!entry.isDirectory()) return []
		const found: ProjectLegacyEntry[] = []
		for (const child of await readdir(root, { withFileTypes: true })) {
			if (!PROJECT_LEGACY_NAMES.has(child.name)) continue
			found.push({
				name: child.name,
				kind: child.isDirectory()
					? 'directory'
					: child.isFile()
						? 'file'
						: child.isSymbolicLink()
							? 'symlink'
							: 'other',
			})
		}
		return found.sort((a, b) => a.name.localeCompare(b.name))
	} catch {
		return []
	}
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

interface GitAnswer {
	readonly code: number
	readonly stdout: string
	readonly stderr: string
}

function git(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<GitAnswer> {
	return new Promise((done) => {
		execFile(
			'git',
			[...args],
			{ cwd, env, timeout: 15_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				// A number is git's exit status; anything else (no git, a timeout) is 127.
				const status = (error as { code?: unknown } | null)?.code
				done({
					code: error === null ? 0 : typeof status === 'number' && status !== 0 ? status : 127,
					stdout: String(stdout ?? ''),
					stderr: String(stderr ?? ''),
				})
			},
		)
	})
}

function firstLine(text: string): string {
	return (
		text
			.split('\n')
			.find((line) => line.trim() !== '')
			?.trim() ?? ''
	)
}

async function canonical(path: string): Promise<string> {
	try {
		return await realpath(path)
	} catch {
		return resolve(path)
	}
}

function inside(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/** Characters a git ignore pattern would read as syntax. */
const UNSAFE_PATTERN = /[*?[\]\\!#\n\r]|^\s|\s$/

export type LegacyExcludeOutcome =
	| { readonly state: 'none' }
	| { readonly state: 'not-a-repository' }
	| { readonly state: 'present'; readonly file: string }
	| { readonly state: 'added'; readonly file: string; readonly names: readonly string[] }
	| { readonly state: 'skipped'; readonly reason: string }

/**
 * Keep git from listing this folder's legacy state in this clone: one block in
 * the clone's own `info/exclude` (the path git names, so a linked worktree
 * shares its main clone's file), anchored to this folder, written once. Only
 * when `<cwd>/.namzu` holds a legacy name, `cwd` is in a git work tree and
 * git's checkout root is the one Namzu found for the folder. An exclude never
 * hides a file git already tracks. Never throws.
 *
 * Call it for a trusted folder only: git reads the repository's own config,
 * which can name programs to run.
 */
export async function excludeProjectLegacy(options: {
	readonly cwd: string
	readonly env?: NodeJS.ProcessEnv
}): Promise<LegacyExcludeOutcome> {
	const env = options.env ?? process.env
	try {
		const cwd = await canonical(options.cwd)
		const entries = await findProjectLegacy(cwd)
		if (entries.length === 0) return { state: 'none' }
		const top = await git(['rev-parse', '--show-toplevel'], cwd, env)
		if (top.code !== 0 || top.stdout.trim() === '') return { state: 'not-a-repository' }
		const checkout = await canonical(top.stdout.trim())
		if (checkout !== (await canonical(cliProjectRoot(cwd)))) {
			return {
				state: 'skipped',
				reason: `git's checkout root ${checkout} is not the folder Namzu found for ${cwd}`,
			}
		}
		const folder = relative(checkout, cwd).split(sep).join('/')
		if (UNSAFE_PATTERN.test(folder)) {
			return { state: 'skipped', reason: 'the folder name cannot be written as a git pattern' }
		}
		const base = folder === '' ? '/.namzu/' : `/${folder}/.namzu/`
		const where = await git(['rev-parse', '--git-path', 'info/exclude'], cwd, env)
		if (where.code !== 0 || where.stdout.trim() === '') {
			return { state: 'skipped', reason: firstLine(where.stderr) || 'git did not name its file' }
		}
		const file = resolve(cwd, where.stdout.trim())
		for (const path of [dirname(file), file]) {
			try {
				const entry = await lstat(path)
				if (entry.isSymbolicLink() || (path === file && !entry.isFile())) {
					return { state: 'skipped', reason: `${path} is not a plain file or folder` }
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
			}
		}
		const header = `# namzu: state an earlier Namzu kept in ${base} (not read; \`namzu state move-legacy\` moves it)`
		let existing = ''
		try {
			existing = await readFile(file, 'utf8')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
		if (existing.split(/\r?\n/).includes(header)) return { state: 'present', file }
		const names = [...PROJECT_LEGACY_NAMES]
		const block = [header, ...names.map((name) => `${base}${name}`), ''].join('\n')
		await mkdir(dirname(file), { recursive: true })
		await appendFile(
			file,
			`${existing === '' || existing.endsWith('\n') ? '' : '\n'}${block}`,
			'utf8',
		)
		return { state: 'added', file, names: entries.map((entry) => entry.name) }
	} catch (cause) {
		return { state: 'skipped', reason: cause instanceof Error ? cause.message : String(cause) }
	}
}

/**
 * The one notice a session start gives when it has just added the exclude
 * block: the person learns once that the folder holds old state, and how to
 * move it. Nothing for any other outcome.
 */
export function describeLegacyExclude(outcome: LegacyExcludeOutcome): string | undefined {
	if (outcome.state !== 'added') return undefined
	const listed = outcome.names
		.slice(0, 4)
		.map((name) => `.namzu/${name}`)
		.join(', ')
	const more = outcome.names.length > 4 ? ` and ${outcome.names.length - 4} more` : ''
	return `This folder holds state an earlier Namzu kept in it (${listed}${more}). Namzu does not read it, and git now leaves it out of this clone. Run namzu state move-legacy to move it into the Namzu home.`
}

// ---------------------------------------------------------------------------
// moving
// ---------------------------------------------------------------------------

export type LegacyMoveOutcome =
	| {
			readonly kind: 'moved'
			/** Relative to `.namzu`, with `/`. */
			readonly name: string
			readonly to: string
			readonly how: 'renamed' | 'copied' | 'git-worktree-move'
	  }
	| {
			readonly kind: 'kept'
			readonly name: string
			readonly reason: string
			readonly copy?: string
	  }
	| { readonly kind: 'gone'; readonly name: string }

export type LegacyMoveResult =
	| { readonly state: 'refused'; readonly reason: string }
	| { readonly state: 'nothing'; readonly root: string }
	| {
			readonly state: 'done'
			readonly root: string
			readonly dryRun: boolean
			/** The run's folder, or for a dry run the folder a run would be made in. */
			readonly destination: string
			readonly outcomes: readonly LegacyMoveOutcome[]
	  }

export interface MoveProjectLegacyOptions {
	readonly cwd: string
	/** The Namzu home (`NAMZU_HOME`, default `~/.namzu`). */
	readonly home: string
	readonly dryRun?: boolean
	readonly env?: NodeJS.ProcessEnv
	readonly now?: () => number
	/** Test seam: the rename that moves one entry. */
	readonly rename?: (from: string, to: string) => Promise<void>
	/** Test seam: runs once a copy is in place, before it is compared. */
	readonly afterCopy?: (copy: string) => Promise<void>
}

interface Worktree {
	readonly path: string
	readonly locked: boolean
}

type KeptPlan = { readonly kind: 'kept'; readonly name: string; readonly reason: string }

type Plan =
	| { readonly kind: 'rename'; readonly name: string }
	| { readonly kind: 'worktree'; readonly name: string }
	| KeptPlan

const TRACKED_REASON = (name: string) =>
	`git tracks files in it; take them out of git first (git rm -r --cached .namzu/${name}) if they should move`

/**
 * Move this folder's legacy state into the Namzu home, or with `dryRun` say
 * what would move. Refuses outright in a folder that is not trusted (git is run
 * in it, and reads its config), when `.namzu` is a link or holds the Namzu
 * home, and while another Namzu is moving the same folder's state. Two movers
 * that slip past the lock still lose nothing: a rename moves an entry once
 * and the other finds it gone, and a copy whose original vanished does not
 * compare equal, so it is kept beside the moved one.
 */
export async function moveProjectLegacyState(
	options: MoveProjectLegacyOptions,
): Promise<LegacyMoveResult> {
	const env = options.env ?? process.env
	const now = options.now ?? Date.now
	let cwd: string
	try {
		cwd = await realpath(resolve(options.cwd))
	} catch {
		return { state: 'refused', reason: `The folder ${options.cwd} could not be read.` }
	}
	const root = join(cwd, '.namzu')
	try {
		const entry = await lstat(root)
		if (entry.isSymbolicLink()) {
			return {
				state: 'refused',
				reason: `${root} is a link; Namzu does not move what it points at.`,
			}
		}
		if (!entry.isDirectory()) return { state: 'nothing', root }
	} catch {
		return { state: 'nothing', root }
	}
	const home = await canonical(options.home)
	if (inside(home, root)) {
		return {
			state: 'refused',
			reason: `${root} holds the Namzu home itself, so its files are already where they belong.`,
		}
	}
	if (!isTrustedAtStateRoot(cwd, home)) {
		return {
			state: 'refused',
			reason:
				'Namzu moves files only out of a folder you trust. Start namzu in this folder and trust it first.',
		}
	}
	const entries = await findProjectLegacy(cwd)
	if (entries.length === 0) return { state: 'nothing', root }

	const plans = await planMoves(cwd, root, entries, env)
	const base = projectLegacyDestination(home, cwd)
	if (options.dryRun) {
		return {
			state: 'done',
			root,
			dryRun: true,
			destination: base,
			outcomes: plans.flatMap((plan): LegacyMoveOutcome[] =>
				plan.kind === 'kept'
					? [plan]
					: [
							{
								kind: 'moved',
								name: plan.name,
								to: join(base, '<time>', ...plan.name.split('/')),
								how: plan.kind === 'worktree' ? 'git-worktree-move' : 'renamed',
							},
						],
			),
		}
	}
	if (plans.every((plan) => plan.kind === 'kept')) {
		return {
			state: 'done',
			root,
			dryRun: false,
			destination: base,
			outcomes: plans.filter((plan): plan is KeptPlan => plan.kind === 'kept'),
		}
	}

	await mkdir(base, { recursive: true, mode: 0o700 })
	const release = await takeLock(`${base}.lock`)
	if (release === undefined) {
		return {
			state: 'refused',
			reason:
				'Another Namzu is moving this folder’s earlier state right now. Run this again when it is done.',
		}
	}
	try {
		const run = await makeRunFolder(base, now())
		await writeFile(
			join(run, 'origin.json'),
			`${JSON.stringify({ v: 1, kind: 'project-legacy', from: root, at: new Date(now()).toISOString() })}\n`,
			{ flag: 'wx', mode: 0o600 },
		)
		const outcomes: LegacyMoveOutcome[] = []
		for (const plan of plans) {
			if (plan.kind === 'kept') {
				outcomes.push(plan)
				continue
			}
			const from = join(root, ...plan.name.split('/'))
			const to = join(run, ...plan.name.split('/'))
			await mkdir(dirname(to), { recursive: true, mode: 0o700 })
			outcomes.push(
				plan.kind === 'worktree'
					? await moveWorktree(cwd, plan.name, from, to, env)
					: await moveEntry(plan.name, from, to, options),
			)
		}
		// A `worktrees/` emptied child by child goes too; one still holding
		// something stays.
		if (plans.some((plan) => plan.name.startsWith('worktrees/'))) {
			await rmdir(join(root, 'worktrees')).catch(() => undefined)
		}
		await syncDirectory(run)
		await syncDirectory(root)
		// A run that moved and copied nothing leaves no folder behind.
		if (
			!outcomes.some(
				(outcome) => outcome.kind === 'moved' || (outcome.kind === 'kept' && outcome.copy),
			)
		) {
			await unlink(join(run, 'origin.json')).catch(() => undefined)
			await rmdir(join(run, 'worktrees')).catch(() => undefined)
			await rmdir(run).catch(() => undefined)
		}
		return { state: 'done', root, dryRun: false, destination: run, outcomes }
	} finally {
		await release()
	}
}

async function planMoves(
	cwd: string,
	root: string,
	entries: readonly ProjectLegacyEntry[],
	env: NodeJS.ProcessEnv,
): Promise<Plan[]> {
	const checkout = cliProjectRoot(cwd)
	const repositoryExpected = existsSync(join(checkout, '.git'))
	let tracked = new Set<string>()
	let worktrees: Worktree[] = []
	if (repositoryExpected) {
		const doubt = (why: string): Plan[] =>
			entries.map((entry) => ({
				kind: 'kept',
				name: entry.name,
				reason: `git could not say which files it tracks here (${why}), so nothing was moved`,
			}))
		const listed = await git(['ls-files', '-z', '--', '.namzu'], cwd, env)
		if (listed.code !== 0) return doubt(firstLine(listed.stderr) || 'git did not answer')
		tracked = new Set(
			listed.stdout
				.split('\0')
				.filter((path) => path.startsWith('.namzu/'))
				.map((path) => path.split('/')[1] ?? ''),
		)
		const list = await git(['worktree', 'list', '--porcelain'], cwd, env)
		if (list.code !== 0) return doubt(firstLine(list.stderr) || 'git did not list its worktrees')
		worktrees = await registeredWorktrees(list.stdout)
	}
	const plans: Plan[] = []
	for (const entry of entries) {
		const path = join(root, entry.name)
		if (tracked.has(entry.name)) {
			plans.push({ kind: 'kept', name: entry.name, reason: TRACKED_REASON(entry.name) })
			continue
		}
		if (entry.kind === 'other') {
			plans.push({ kind: 'kept', name: entry.name, reason: 'it is not a file, a folder or a link' })
			continue
		}
		const within = worktrees.filter((worktree) => inside(worktree.path, path))
		if (within.length === 0) {
			plans.push({ kind: 'rename', name: entry.name })
			continue
		}
		if (entry.name !== 'worktrees' || entry.kind !== 'directory') {
			plans.push({
				kind: 'kept',
				name: entry.name,
				reason: `it holds the git worktree ${within[0]?.path}; move that with git worktree move first`,
			})
			continue
		}
		plans.push(...(await planWorktreeChildren(path, within, env)))
	}
	return plans
}

async function planWorktreeChildren(
	folder: string,
	registered: readonly Worktree[],
	env: NodeJS.ProcessEnv,
): Promise<Plan[]> {
	const plans: Plan[] = []
	for (const child of (await readdir(folder)).sort()) {
		const name = `worktrees/${child}`
		const path = join(folder, child)
		const exact = registered.find((worktree) => worktree.path === path)
		const deeper = registered.find(
			(worktree) => worktree.path !== path && inside(worktree.path, path),
		)
		if (deeper) {
			plans.push({
				kind: 'kept',
				name,
				reason: `it holds the git worktree ${deeper.path}; move that with git worktree move first`,
			})
		} else if (!exact) {
			plans.push({ kind: 'rename', name })
		} else if (exact.locked) {
			plans.push({ kind: 'kept', name, reason: 'git keeps this worktree locked' })
		} else {
			const status = await git(['status', '--porcelain'], path, env)
			if (status.code !== 0) {
				plans.push({ kind: 'kept', name, reason: 'git could not say whether it has changes' })
			} else if (status.stdout.trim() !== '') {
				plans.push({
					kind: 'kept',
					name,
					reason: 'this git worktree has changes that are not committed',
				})
			} else {
				plans.push({ kind: 'worktree', name })
			}
		}
	}
	return plans
}

async function registeredWorktrees(porcelain: string): Promise<Worktree[]> {
	const found: Worktree[] = []
	for (const block of porcelain.split(/\n\n+/)) {
		const lines = block.split('\n')
		const head = lines.find((line) => line.startsWith('worktree '))
		if (!head) continue
		found.push({
			path: await canonical(head.slice('worktree '.length)),
			locked: lines.some((line) => line === 'locked' || line.startsWith('locked ')),
		})
	}
	return found
}

async function moveWorktree(
	cwd: string,
	name: string,
	from: string,
	to: string,
	env: NodeJS.ProcessEnv,
): Promise<LegacyMoveOutcome> {
	const moved = await git(['worktree', 'move', from, to], cwd, env)
	if (moved.code === 0) return { kind: 'moved', name, to, how: 'git-worktree-move' }
	return {
		kind: 'kept',
		name,
		reason: `git did not move the worktree: ${firstLine(moved.stderr) || 'no reason given'}`,
	}
}

async function moveEntry(
	name: string,
	from: string,
	to: string,
	options: MoveProjectLegacyOptions,
): Promise<LegacyMoveOutcome> {
	try {
		await lstat(from)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'gone', name }
		return { kind: 'kept', name, reason: errorText(error) }
	}
	try {
		await (options.rename ?? rename)(from, to)
		return { kind: 'moved', name, to, how: 'renamed' }
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === 'ENOENT') return { kind: 'gone', name }
		if (code !== 'EXDEV') return { kind: 'kept', name, reason: errorText(error) }
	}
	// Another file system: copy, flush, put the copy in place, compare, and
	// only then remove the original.
	const partial = `${to}.partial`
	try {
		await copyTree(from, partial)
		await rename(partial, to)
	} catch (error) {
		await rm(partial, { recursive: true, force: true }).catch(() => undefined)
		return { kind: 'kept', name, reason: `it could not be copied: ${errorText(error)}` }
	}
	await options.afterCopy?.(to)
	let same: boolean
	try {
		same = (await treeDigest(from)) === (await treeDigest(to))
	} catch {
		same = false
	}
	if (!same) {
		return {
			kind: 'kept',
			name,
			copy: to,
			reason:
				'the copy did not match the original (it may have changed while it was copied), so both are kept',
		}
	}
	try {
		await rm(from, { recursive: true })
	} catch (error) {
		return {
			kind: 'kept',
			name,
			copy: to,
			reason: `it was copied, but the original could not be removed completely (${errorText(error)}), so both are kept`,
		}
	}
	return { kind: 'moved', name, to, how: 'copied' }
}

/** Copy without following links; every file is flushed before the copy is used. */
async function copyTree(from: string, to: string): Promise<void> {
	const entry = await lstat(from)
	if (entry.isSymbolicLink()) {
		await symlink(await readlink(from), to)
	} else if (entry.isDirectory()) {
		await mkdir(to, { mode: 0o700 })
		for (const child of await readdir(from)) await copyTree(join(from, child), join(to, child))
	} else if (entry.isFile()) {
		await copyFile(from, to, constants.COPYFILE_EXCL)
		const handle = await open(to, 'r+')
		try {
			await handle.sync()
		} finally {
			await handle.close()
		}
	} else {
		throw new Error(`${from} is not a file, a folder or a link`)
	}
}

/** Every path under `root` with its kind, size, content hash or link target, as one string. */
async function treeDigest(root: string): Promise<string> {
	const lines: string[] = []
	const visit = async (path: string, name: string): Promise<void> => {
		const entry = await lstat(path)
		if (entry.isSymbolicLink()) lines.push(`${name}\0link\0${await readlink(path)}`)
		else if (entry.isDirectory()) {
			lines.push(`${name}\0dir`)
			for (const child of (await readdir(path)).sort()) {
				await visit(join(path, child), `${name}/${child}`)
			}
		} else if (entry.isFile()) lines.push(`${name}\0file\0${entry.size}\0${await fileHash(path)}`)
		else lines.push(`${name}\0other`)
	}
	await visit(root, '.')
	return lines.join('\n')
}

function fileHash(path: string): Promise<string> {
	return new Promise((done, fail) => {
		const hash = createHash('sha256')
		createReadStream(path)
			.on('data', (chunk) => hash.update(chunk))
			.on('error', fail)
			.on('end', () => done(hash.digest('hex')))
	})
}

async function makeRunFolder(base: string, start: number): Promise<string> {
	for (let stamp = start; stamp < start + 1000; stamp += 1) {
		const path = join(base, String(stamp))
		try {
			await mkdir(path, { mode: 0o700 })
			return path
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		}
	}
	throw new Error(`No free folder under ${base}`)
}

/** One mover per folder: `<base>.lock` holds the owner's pid; a dead owner's lock is taken over. */
async function takeLock(path: string): Promise<(() => Promise<void>) | undefined> {
	const body = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}\n`
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await writeFile(path, body, { flag: 'wx', mode: 0o600 })
			return async () => {
				const held = await readFile(path, 'utf8').catch(() => '')
				if (held === body) await unlink(path).catch(() => undefined)
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
			const held = await readFile(path, 'utf8').catch(() => '')
			const pid = Number(held.split(':')[0])
			if (Number.isSafeInteger(pid) && pid > 0 && processAlive(pid)) return undefined
			// The owner is gone: take its lock over, once.
			await unlink(path).catch(() => undefined)
		}
	}
	return undefined
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

async function syncDirectory(path: string): Promise<void> {
	if (process.platform === 'win32') return
	try {
		const handle = await open(path, 'r')
		try {
			await handle.sync()
		} finally {
			await handle.close()
		}
	} catch {
		// Best effort: the renames themselves are done.
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
