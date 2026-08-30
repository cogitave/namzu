/**
 * A hash of everything a run could have changed in its working tree.
 *
 * It exists to answer one question, asked between two attempts at the same
 * verification: **did anything happen since it last failed?** A verify-then-fix
 * loop that re-runs the build after a turn which edited nothing spends a full
 * command execution to learn what a comparison already knew, and does it once
 * per remaining attempt — so a model that has stopped making progress burns
 * the entire budget confirming the same failure.
 *
 * ## What is hashed, and why each part
 *
 * Three sources, because no one of them is complete:
 *
 *  1. **`git status --porcelain`** — which paths differ from the index at all.
 *     Cheap, and it catches additions, deletions and mode changes. On its own
 *     it is not enough: editing a tracked file that was ALREADY modified
 *     leaves the status output byte-identical.
 *  2. **`git diff --binary HEAD`** — the content of every tracked change.
 *     `--binary` so an edit to a file git treats as binary is a real diff
 *     rather than the constant line `Binary files … differ`, which would make
 *     every edit to such a file invisible.
 *  3. **Untracked file contents**, which no `git diff` covers. A new file is
 *     named by `status` but its CONTENT is not, so successive edits to a
 *     brand-new file would otherwise look like no change at all.
 *
 * ### Symlinks are recorded as their target, not read through
 *
 * Reading a link follows it, so a link repointed from one file to another
 * with identical contents hashes the same — while the thing the workspace
 * actually resolves has changed. The link's target path is the fact that
 * moved, so that is what goes in.
 *
 * ## Failing open, on the cheap side
 *
 * Every uncertainty returns `null`, meaning *no fingerprint*, and a caller
 * that cannot fingerprint re-runs its command. That is the correct direction:
 * the cost of a wrong `null` is one command execution, and the cost of a
 * wrong MATCH is a verification silently skipped — the loop would report
 * "nothing changed" about a workspace that did change, and the model would be
 * told to edit something it had already edited.
 *
 * So: a non-zero exit from any git invocation, a repository with no commits,
 * a timeout, an executor-reported truncated stream, or output past the size
 * cap all produce `null` rather than a partial hash. A truncated diff that
 * hashed successfully would be the worst outcome available here, because two
 * different workspaces truncated at the same point collide.
 */

import { createHash } from 'node:crypto'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'

import type { CommandOptions, CommandResult } from '../types/execution/index.js'

/** How a fingerprint runs git. Injected so a test needs no repository. */
export type FingerprintExec = (
	command: string,
	args: string[],
	options?: CommandOptions,
) => Promise<CommandResult>

/**
 * The three filesystem reads an untracked entry needs.
 *
 * Injectable for one specific reason, written down because a seam that
 * exists only for tests is usually a smell: **creating a symlink requires a
 * privilege that is not granted by default on Windows**, so the symlink rule
 * below — the one that says a repointed link changes the fingerprint even
 * when the bytes behind it do not — cannot be exercised on a developer
 * machine without it. A rule that can only be checked on some machines is a
 * rule nobody checks.
 *
 * The default is `node:fs/promises` and every other test uses it against a
 * real repository, so this is not a fixture standing in for production; it is
 * one branch of one function reached without a privilege.
 */
export interface FingerprintFs {
	lstat(path: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean }>
	readlink(path: string): Promise<string>
	readFile(path: string): Promise<Buffer>
}

const NODE_FS: FingerprintFs = { lstat, readlink, readFile }

/**
 * Cap on the bytes any single git invocation may produce.
 *
 * Past it the fingerprint is abandoned rather than hashed. A diff big enough
 * to hit this is a diff nobody is going to iterate on anyway, and hashing a
 * clipped one would let two different trees agree.
 */
export const FINGERPRINT_MAX_BYTES = 4 * 1024 * 1024

/** Default deadline per git invocation. */
export const FINGERPRINT_TIMEOUT_MS = 20_000

export interface WorkspaceFingerprintOptions {
	/** Repository root, or any directory inside it. */
	readonly cwd: string
	/** How to run git. */
	readonly exec: FingerprintExec
	/** Per-invocation deadline. See {@link FINGERPRINT_TIMEOUT_MS}. */
	readonly timeoutMs?: number
	/** See {@link FINGERPRINT_MAX_BYTES}. */
	readonly maxBytes?: number
	/** Filesystem reads. See {@link FingerprintFs}. */
	readonly fs?: FingerprintFs
}

/** One untracked path's contribution, or `null` when it could not be read. */
async function untrackedEntry(cwd: string, rel: string, fs: FingerprintFs): Promise<string | null> {
	const abs = join(cwd, rel)
	try {
		const stats = await fs.lstat(abs)
		if (stats.isSymbolicLink()) {
			// The TARGET, not what is behind it. Following the link would hash a
			// repointed link to the same value whenever the new target happens
			// to hold the same bytes, and a repoint is a change to the workspace
			// by any reading that matters.
			return `L ${rel}\0${await fs.readlink(abs)}`
		}
		if (!stats.isFile()) return `? ${rel}`
		const body = await fs.readFile(abs)
		return `F ${rel}\0${createHash('sha256').update(body).digest('hex')}`
	} catch {
		// Vanished between the listing and the read, or unreadable. Neither is
		// a fingerprint this function may guess at.
		return null
	}
}

/**
 * A hash of the working tree's uncommitted state, or `null` when it cannot be
 * established.
 *
 * **`null` is never "unchanged".** It means "I cannot tell", and the caller
 * must treat it as a reason to do the work rather than to skip it.
 */
export async function fingerprintWorkspace(
	options: WorkspaceFingerprintOptions,
): Promise<string | null> {
	const { cwd, exec } = options
	const timeoutMs = options.timeoutMs ?? FINGERPRINT_TIMEOUT_MS
	const maxBytes = options.maxBytes ?? FINGERPRINT_MAX_BYTES
	const fs = options.fs ?? NODE_FS

	const git = async (args: string[]): Promise<string | null> => {
		let result: CommandResult
		try {
			result = await exec('git', args, { cwd, timeoutMs })
		} catch {
			return null
		}
		// A timeout surfaces here as a non-zero exit, and so does "not a
		// repository" and "no commits yet". All three mean the same thing to
		// this function: it has no basis for a comparison.
		if (result.exitCode !== 0) return null
		if (result.stdoutTruncated === true || result.stderrTruncated === true) return null
		if (Buffer.byteLength(result.stdout, 'utf8') > maxBytes) return null
		return result.stdout
	}

	const status = await git(['status', '--porcelain'])
	if (status === null) return null

	const diff = await git(['diff', '--binary', 'HEAD'])
	if (diff === null) return null

	const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'])
	if (untracked === null) return null

	const parts = [`status ${status}`, `diff ${diff}`]
	// Split on NUL, which is what `-z` is for: a path may contain a newline,
	// and splitting on one would turn a single strange filename into two
	// ordinary-looking ones.
	//
	// Sorted, because `ls-files` order is not part of any contract and a
	// fingerprint that moved when the listing order did would report a change
	// nobody made.
	for (const rel of untracked.split('\0').filter(Boolean).sort()) {
		const entry = await untrackedEntry(cwd, rel, fs)
		if (entry === null) return null
		parts.push(entry)
	}

	// Length-prefixed rather than delimiter-joined. A diff can contain any
	// byte, so any separator is a separator the content can forge — and two
	// different trees that agreed after forgery would be reported as
	// unchanged, which is the one wrong answer this file is arranged to avoid.
	const hash = createHash('sha256')
	for (const part of parts) hash.update(`${Buffer.byteLength(part, 'utf8')}:${part}`)
	return hash.digest('hex')
}
