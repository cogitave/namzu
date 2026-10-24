import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { ToolDiffHunk } from '@namzu/sdk'

import { type DiffInfo, WORKSPACE_PREVIEW_ROWS, plainDiffRows } from './diff-view.js'

const run = promisify(execFile)

/** Long enough for a large repository, short enough not to hang a keystroke. */
const DIFF_TIMEOUT_MS = 10_000

/**
 * Bytes of patch body to show before saying how much was left out.
 *
 * A transcript is not a pager. A diff that scrolls the session away answers
 * "what changed" by making the answer unreadable, and the operator's next move
 * is `git diff` in another terminal anyway — so the cap is generous enough for
 * an ordinary change and honest about the rest.
 */
const DIFF_MAX_BYTES = 24_000

export interface WorkspaceDiff {
	/** `git diff --stat`, one line per file. Empty when nothing changed. */
	readonly stat: string
	/** The patch body, possibly truncated — see `truncated`. */
	readonly patch: string
	readonly truncated: boolean
	/** Paths git knows nothing about yet, which no diff would show. */
	readonly untracked: readonly string[]
}

/**
 * What is uncommitted in this working tree.
 *
 * **Not "what this session changed", and the command says so.** The CLI cannot
 * tell the agent's edits from the operator's: the tool events carry a
 * human-readable summary rather than a path, and parsing a path back out of
 * prose would be a guess dressed as attribution. Reporting the working tree and
 * naming it accurately is the answer that is true.
 *
 * `null` means "I cannot tell" — not a repository, no git, a timeout — and a
 * caller must say that rather than render an empty diff, which reads as
 * "nothing changed" and is a different claim entirely. The same contract
 * `fingerprintWorkspace` holds, for the same reason.
 *
 * Untracked files are listed separately because `git diff` does not show them
 * at all: a session whose entire output is new files would otherwise report
 * that it changed nothing.
 */
export async function workspaceDiff(cwd: string): Promise<WorkspaceDiff | null> {
	const git = async (args: readonly string[]): Promise<string | null> => {
		try {
			const { stdout } = await run('git', [...args], {
				cwd,
				timeout: DIFF_TIMEOUT_MS,
				maxBuffer: 1024 * 1024 * 8,
			})
			return stdout
		} catch {
			// Not a repository, git absent, timeout, or a buffer overrun. All of
			// them mean the same thing here: no basis for an answer.
			return null
		}
	}

	// Tracked changes only — `--` guards a branch or file named like a flag.
	const stat = await git(['diff', '--stat', 'HEAD', '--'])
	if (stat === null) return null

	const patchRaw = (await git(['diff', 'HEAD', '--'])) ?? ''
	const truncated = Buffer.byteLength(patchRaw, 'utf8') > DIFF_MAX_BYTES
	const patch = truncated ? patchRaw.slice(0, DIFF_MAX_BYTES) : patchRaw

	const untrackedRaw = (await git(['ls-files', '--others', '--exclude-standard'])) ?? ''
	const untracked = untrackedRaw.split('\n').filter((line) => line.length > 0)

	return { stat: stat.trimEnd(), patch, truncated, untracked }
}

interface FileDiff {
	readonly path: string
	readonly hunks: ToolDiffHunk[]
	readonly binary: boolean
	added: number
	removed: number
}

/**
 * A unified patch as one entry per file with its hunks, so the body can be
 * drawn the way an edit is (a line-number gutter, context, a gap between
 * hunks). A patch cut off mid-hunk ends in a shorter hunk, which is shown
 * as far as it goes; counts are taken from the rows that are there.
 */
export function parsePatch(patch: string): FileDiff[] {
	const files: FileDiff[] = []
	let file: FileDiff | undefined
	let hunk: { header: ToolDiffHunk; lines: string[] } | undefined
	const close = () => {
		if (file && hunk) {
			file.hunks.push({ ...hunk.header, lines: hunk.lines })
		}
		hunk = undefined
	}
	for (const line of patch.split('\n')) {
		const start = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
		if (start) {
			close()
			file = { path: start[2] ?? start[1] ?? '', hunks: [], binary: false, added: 0, removed: 0 }
			files.push(file)
			continue
		}
		if (!file) continue
		const at = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
		if (at) {
			close()
			hunk = {
				header: {
					oldStart: Number(at[1]),
					oldLines: at[2] === undefined ? 1 : Number(at[2]),
					newStart: Number(at[3]),
					newLines: at[4] === undefined ? 1 : Number(at[4]),
					lines: [],
				},
				lines: [],
			}
			continue
		}
		if (/^Binary files .* differ$/.test(line) || line.startsWith('GIT binary patch')) {
			file = { ...file, binary: true }
			files[files.length - 1] = file
			continue
		}
		if (!hunk) continue
		const marker = line[0]
		if (marker === '+') file.added += 1
		else if (marker === '-') file.removed += 1
		else if (marker !== ' ') continue
		hunk.lines.push(line)
	}
	close()
	return files
}

/** `+2 −1`; a side with nothing is left out. */
function counts(added: number, removed: number): string {
	return [
		added ? `+${added.toLocaleString('en-US')}` : '',
		removed ? `−${removed.toLocaleString('en-US')}` : '',
	]
		.filter(Boolean)
		.join(' ')
}

/** One heading per file with its counts, and the file's hunks. */
function patchFiles(patch: string): NonNullable<DiffInfo['files']> {
	return parsePatch(patch).map((file) => {
		const stats = counts(file.added, file.removed)
		return {
			heading: file.binary
				? `${file.path} · binary file`
				: stats
					? `${file.path} ${stats}`
					: file.path,
			hunks: file.binary ? [] : file.hunks,
		}
	})
}

/**
 * The diff as transcript lines: a short answer, with the patch underneath.
 *
 * Returned as `{ summary, detail }` rather than one blob so the caller can put
 * the body in a collapsed block — the same treatment a tool's output gets, and
 * for the same reason.
 */
export function renderWorkspaceDiff(diff: WorkspaceDiff | null): {
	summary: string
	detail: readonly string[]
	/** `detail` is the patch, drawn as an edit is (see `diff-view.ts`). */
	diff?: DiffInfo
} {
	if (diff === null) {
		return {
			summary: 'Cannot read a diff here — this is not a git repository, or git is unavailable.',
			detail: [],
		}
	}

	const nothingTracked = diff.stat.length === 0
	if (nothingTracked && diff.untracked.length === 0) {
		return { summary: 'Working tree clean — nothing uncommitted.', detail: [] }
	}

	const parts: string[] = []
	if (!nothingTracked) parts.push(diff.stat)
	if (diff.untracked.length > 0) {
		parts.push('')
		parts.push(`Untracked (${diff.untracked.length}), which no diff shows:`)
		for (const path of diff.untracked) parts.push(`  ${path}`)
	}

	let info: DiffInfo | undefined
	if (diff.patch.length > 0) {
		info = {
			mode: 'hunks',
			hunks: [],
			preview: WORKSPACE_PREVIEW_ROWS,
			files: patchFiles(diff.patch),
			...(diff.truncated ? { footer: ['', '… truncated. Run `git diff` for the rest.'] } : {}),
		}
	}
	const detail = info ? plainDiffRows(info) : []

	// Stated on every non-empty answer, because the alternative is an operator
	// reading their own uncommitted work as the agent's.
	parts.push('')
	parts.push('This is the whole working tree, not only what the agent changed.')

	return {
		summary: parts.join('\n'),
		detail,
		...(info && detail.length > 0 ? { diff: info } : {}),
	}
}
