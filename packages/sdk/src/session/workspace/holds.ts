/**
 * WorkspaceHoldStore — which live session or subagent is working in a checkout.
 *
 * A Git worktree belongs to whoever is using it right now, not only to the ref
 * a driver created it from. A driver that removes a checkout while another
 * process has it open takes that process's uncommitted files with it, so a
 * removal asks this store first.
 *
 * ## What is on disk
 *
 * `<root>/workspace-holds/<key>/<pid>-<token>.json`, one file per holding, so
 * two holders of the same path never write over each other and neither needs a
 * lock. `<key>` is a hash of the canonical path; the body carries the path
 * itself, so a key that belongs to something else is never believed.
 *
 * ## How liveness is decided
 *
 * A holding is the pid of the process that took it. On this machine the pid is
 * asked whether it still exists: a crashed or killed session leaves its file
 * behind, and every later look unlinks it. A record from another host on a
 * shared home directory cannot be checked from here, so it is treated as live —
 * the same rule the stored-memory lock uses. The residual risk is the same and
 * is deliberate: a pid reused by an unrelated process reads as live, and a
 * checkout stays where it is rather than being removed on a guess.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { hostname as osHostname } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveNamzuHome } from '../home.js'

/** One live use of a checkout. */
export interface WorkspaceHold {
	/** The managed checkout root that must not be removed. */
	readonly path: string
	/** The folder the holder works in, which may be below `path`. */
	readonly folder: string
	/** Who holds it, for a person reading the refusal or the log. */
	readonly holder: string
}

export interface WorkspaceHoldRequest {
	/** The checkout root, as the driver knows it. */
	readonly path: string
	/** The folder the holder works in. Defaults to `path`. */
	readonly folder?: string
	/** A short, honest description: `session:1234`, `subagent:1234:review`. */
	readonly holder: string
}

/** Ask a store who is working in a checkout, and record this process doing so. */
export interface WorkspaceHoldStore {
	/**
	 * Record a holding. Resolves with an idempotent release; the caller keeps it
	 * for as long as it works in the checkout and releases it before it ends.
	 */
	add(request: WorkspaceHoldRequest): Promise<() => Promise<void>>
	/** Live holdings of `path`; empty when nothing holds it. */
	holders(path: string): Promise<readonly WorkspaceHold[]>
}

export interface DiskWorkspaceHoldStoreOptions {
	/** Directory the holdings live in. Defaults to {@link defaultWorkspaceHoldsDir}. */
	readonly root?: string
	/** True when a process with this pid exists on this machine. */
	readonly isPidAlive?: (pid: number) => boolean
	readonly hostname?: string
}

/** The refusal a removal reports when a live session or subagent still has the checkout. */
export class WorkspaceInUseError extends Error {
	override readonly name = 'WorkspaceInUseError'
	constructor(
		readonly path: string,
		readonly holders: readonly WorkspaceHold[],
	) {
		const who = holders
			.map((hold) => `${hold.holder}, working in ${hold.folder}`)
			.join('; ')
		super(
			`The worktree ${path} was not removed: a running session or subagent still has it (${who}). Its uncommitted files are untouched. Close that session, then remove it again.`,
		)
	}
}

function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		// EPERM means the process is there and belongs to somebody else.
		return (error as NodeJS.ErrnoException).code !== 'ESRCH'
	}
}

function isErrno(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === code
}

function keyFor(path: string): string {
	return createHash('sha256').update(path).digest('hex').slice(0, 24)
}

interface HoldBody {
	readonly v: 1
	readonly path: string
	readonly folder: string
	readonly holder: string
	readonly pid: number
	readonly hostname: string
	readonly startedAt: string
}

/** Resolve every existing path component, so two spellings of one folder share a key. */
async function canonical(path: string): Promise<string> {
	try {
		return await realpath(resolve(path))
	} catch {
		return resolve(path)
	}
}

export class DiskWorkspaceHoldStore implements WorkspaceHoldStore {
	private readonly root: string
	private readonly isPidAlive: (pid: number) => boolean
	private readonly hostname: string

	constructor(options: DiskWorkspaceHoldStoreOptions = {}) {
		this.root = resolve(options.root ?? defaultWorkspaceHoldsDir())
		this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive
		this.hostname = options.hostname ?? osHostname()
	}

	private async directoryFor(path: string): Promise<string> {
		return join(this.root, keyFor(await canonical(path)))
	}

	async add(request: WorkspaceHoldRequest): Promise<() => Promise<void>> {
		const path = await canonical(request.path)
		const directory = await this.directoryFor(path)
		await mkdir(directory, { recursive: true, mode: 0o700 })
		const body: HoldBody = {
			v: 1,
			path,
			folder: await canonical(request.folder ?? path),
			holder: request.holder,
			pid: process.pid,
			hostname: this.hostname,
			startedAt: new Date().toISOString(),
		}
		const file = join(directory, `${process.pid}-${randomUUID()}.json`)
		await writeFile(file, `${JSON.stringify(body)}\n`, { flag: 'wx', mode: 0o600 })
		let released = false
		return async () => {
			if (released) return
			released = true
			await unlink(file).catch((error) => {
				if (!isErrno(error, 'ENOENT')) throw error
			})
		}
	}

	async holders(path: string): Promise<readonly WorkspaceHold[]> {
		const canonicalPath = await canonical(path)
		const directory = await this.directoryFor(canonicalPath)
		let names: string[]
		try {
			names = await readdir(directory)
		} catch (error) {
			if (isErrno(error, 'ENOENT')) return []
			throw error
		}
		const found: WorkspaceHold[] = []
		for (const name of names.sort()) {
			if (!name.endsWith('.json')) continue
			const file = join(directory, name)
			let body: HoldBody
			try {
				body = JSON.parse(await readFile(file, 'utf8')) as HoldBody
			} catch {
				continue
			}
			if (body.v !== 1 || body.path !== canonicalPath) continue
			if (body.hostname !== this.hostname) {
				found.push({ path: body.path, folder: body.folder, holder: body.holder })
				continue
			}
			if (this.isPidAlive(body.pid)) {
				found.push({ path: body.path, folder: body.folder, holder: body.holder })
				continue
			}
			// The holder is gone and its release never ran: this file is litter.
			await unlink(file).catch(() => undefined)
		}
		return found
	}
}

/** `<NAMZU_HOME>/workspace-holds`: one machine's view of who has which checkout. */
export function defaultWorkspaceHoldsDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(resolveNamzuHome({ env }), 'workspace-holds')
}
