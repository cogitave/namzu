/**
 * What the CLI adds to resuming a workflow run: where the editable copy of a
 * script lives and how a script file is read back, the rules a script's text
 * must meet, the secret that signs a run's journal, and the plain-language
 * summary the operator reviews before a resume starts.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
	type WorkflowResumeState,
	loadWorkflowResume,
	readWorkflowJournalChecked,
} from '@namzu/sdk'

/** Longest script, in bytes, that a tool call or a saved file may carry. */
export const MAX_SCRIPT_BYTES = 262_144

/** The shape of a run id. */
export const RUN_ID_PATTERN = /^w[0-9a-z]{8}$/

/** The text a person sees when a script has a character the review cannot show. */
const CONTROL_CHARACTER_MESSAGE =
	'The script contains a control character that the review cannot show, such as an escape byte or a lone carriage return. Remove it and try again.'

/** A script's problem with the review, or `undefined` when it can be shown whole. */
export function controlCharacterProblem(script: string): string | undefined {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the check for exactly these bytes
	if (/\u001b/.test(script) || /\r(?!\n)/.test(script)) return CONTROL_CHARACTER_MESSAGE
	return undefined
}

/** Where the editable copies of this conversation's workflow scripts are kept. */
export function scriptsDirectory(runsDirectory: string): string {
	return join(dirname(runsDirectory), 'workflows', 'scripts')
}

function slug(name: string): string {
	const text = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
		.replace(/-+$/g, '')
	return text.length > 0 ? text : 'workflow'
}

/** `<scripts>/<name>-<runId>.js`: named after the script and the run it belongs to. */
export function editableCopyPath(runsDirectory: string, name: string, runId: string): string {
	return join(scriptsDirectory(runsDirectory), `${slug(name)}-${runId}.js`)
}

/** Write the editable copy (mode 0600 in a 0700 directory). Reports whether it was written. */
export async function writeEditableCopy(path: string, script: string): Promise<boolean> {
	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 })
		await writeFile(path, script, { mode: 0o600 })
		return true
	} catch {
		return false
	}
}

export type SavedScript =
	| { readonly ok: true; readonly text: string; readonly path: string }
	| { readonly ok: false; readonly error: string }

/**
 * Read a script the model saved earlier, fresh on every call. Only a regular
 * file (no link, no second name) inside the conversation's scripts directory
 * is read, so the path cannot be used to read anything else.
 */
export function readSavedScript(path: string, directory: string): SavedScript {
	if (path.startsWith('\\\\') || path.startsWith('//')) {
		return { ok: false, error: `Network paths are not allowed for scriptPath: ${path}` }
	}
	const full = resolve(path)
	let root: string
	try {
		root = realpathSync(directory)
	} catch {
		return {
			ok: false,
			error: `Cannot read ${path} because it is outside the folder this conversation keeps its workflow scripts in: ${directory}`,
		}
	}
	let stat: ReturnType<typeof lstatSync>
	let parent: string
	try {
		stat = lstatSync(full)
		parent = realpathSync(dirname(full))
	} catch {
		return { ok: false, error: `That script file was not found: ${path}` }
	}
	const inside = relative(root, parent)
	if (inside.startsWith('..') || isAbsolute(inside)) {
		return {
			ok: false,
			error: `Cannot read ${path} because it is outside the folder this conversation keeps its workflow scripts in: ${directory}`,
		}
	}
	if (!stat.isFile() || stat.nlink !== 1) {
		return { ok: false, error: `${path} is not a regular file` }
	}
	if (stat.size > MAX_SCRIPT_BYTES) {
		return { ok: false, error: `${path} is larger than ${MAX_SCRIPT_BYTES} bytes` }
	}
	let text: string
	try {
		text = readFileSync(full, 'utf8')
		const again = lstatSync(full)
		if (again.ino !== stat.ino || again.size !== stat.size || again.isSymbolicLink()) {
			return { ok: false, error: `${path} changed while it was being read. Try again.` }
		}
	} catch {
		return { ok: false, error: `That script file was not found: ${path}` }
	}
	return { ok: true, text: text.replace(/\r\n/g, '\n'), path: full }
}

/**
 * The secret that signs every line of a run's journal. It lives beside the
 * conversation store, outside every folder a tool call writes in, and is made
 * on first use. `undefined` when it cannot be read or made: journals are then
 * chained but not signed.
 */
export function workflowJournalKey(home: string): string | undefined {
	const file = join(home, 'workflow-journal.key')
	try {
		if (existsSync(file)) {
			const text = readFileSync(file, 'utf8').trim()
			if (text.length >= 32) return text
		}
		mkdirSync(home, { recursive: true, mode: 0o700 })
		const fresh = randomBytes(32).toString('hex')
		writeFileSync(file, `${fresh}\n`, { mode: 0o600, flag: 'wx' })
		chmodSync(file, 0o600)
		return fresh
	} catch {
		try {
			const text = readFileSync(file, 'utf8').trim()
			return text.length >= 32 ? text : undefined
		} catch {
			return undefined
		}
	}
}

/** What the operator reads before a resume starts. */
export interface ResumeReview {
	readonly runId: string
	readonly pass: number
	readonly previousFinish: WorkflowResumeState['previousFinish']
	readonly resumable: boolean
	readonly legacy: boolean
	/** Agents whose result is saved. */
	readonly saved: number
	/** Agents that started in an earlier pass and did not finish. */
	readonly unfinished: number
	/** Agents that failed or were skipped. */
	readonly failed: number
	/** `true`/`false` once the script is compared with the one the run started from. */
	readonly scriptChanged?: boolean
	readonly brokenAt?: number
	readonly problems: readonly string[]
}

/** Read a run's journal and say what a resume would reuse. Synchronous: the review draws it at once. */
export function describeResume(
	runsDirectory: string,
	runId: string,
	script: string | undefined,
	key?: string,
): ResumeReview {
	const base = {
		runId,
		pass: 1,
		previousFinish: 'unfinished' as const,
		saved: 0,
		unfinished: 0,
		failed: 0,
	}
	if (!RUN_ID_PATTERN.test(runId)) {
		return {
			...base,
			resumable: false,
			legacy: false,
			problems: [`${runId} is not a workflow run id.`],
		}
	}
	let text = ''
	try {
		text = readFileSync(join(runsDirectory, runId, 'workflow', 'journal.jsonl'), 'utf8')
	} catch {
		return {
			...base,
			resumable: false,
			legacy: false,
			problems: [`There is no saved journal for workflow ${runId} in this conversation.`],
		}
	}
	const checked = readWorkflowJournalChecked(text, runId, key !== undefined ? { key } : {})
	const state = loadWorkflowResume(checked)
	const unfinished = [...state.seen].filter(
		(k) => !state.results.has(k) && !state.failed.has(k),
	).length
	const scriptChanged =
		script !== undefined && state.scriptSha256 !== undefined
			? createHash('sha256').update(script).digest('hex') !== state.scriptSha256
			: undefined
	return {
		runId,
		pass: state.pass,
		previousFinish: state.previousFinish,
		resumable: state.resumable,
		legacy: checked.legacy,
		saved: state.results.size,
		unfinished,
		failed: state.failed.size,
		...(scriptChanged !== undefined ? { scriptChanged } : {}),
		...(state.brokenAt !== undefined ? { brokenAt: state.brokenAt } : {}),
		problems: state.problems,
	}
}

const FINISH_WORDS: Record<ResumeReview['previousFinish'], string> = {
	completed: 'the previous pass completed',
	failed: 'the previous pass failed',
	stopped: 'the previous pass was stopped',
	unfinished: 'the previous pass did not finish',
}

function agents(count: number): string {
	return `${count} agent${count === 1 ? '' : 's'}`
}

/** The lines of the review block. Figures are forecasts unless the script is unchanged. */
export function resumeReviewLines(review: ResumeReview): string[] {
	if (!review.resumable) {
		return [
			`Resumes run ${review.runId}, which cannot be resumed.`,
			...review.problems.map((problem) => `  ${problem}`),
		]
	}
	const lines = [
		`Resumes run ${review.runId} (pass ${review.pass}; ${FINISH_WORDS[review.previousFinish]})`,
	]
	if (review.scriptChanged === false) {
		lines.push(
			`  About ${agents(review.saved)} return saved results and are not run again; ${review.unfinished + review.failed} run.`,
		)
		lines.push('  Script: unchanged since the run started')
	} else {
		lines.push(
			`  Up to ${agents(review.saved)} can return saved results. Unfinished: ${review.unfinished}. Failed or skipped: ${review.failed}.`,
		)
		lines.push(
			review.scriptChanged === true
				? '  Script: edited since the run started; unchanged agent calls return saved results, edited or later ones run'
				: '  Script: not compared with the original; calls that differ run again',
		)
	}
	if (review.brokenAt !== undefined) {
		lines.push(
			`  Journal: changed or cut short at line ${review.brokenAt}; results after that point are not trusted and run again`,
		)
	}
	return lines
}

/** The call a model makes to resume a run, as text for a notice. */
export function resumeCallText(scriptPath: string | undefined, runId: string): string {
	return scriptPath !== undefined
		? `workflow({scriptPath: ${JSON.stringify(scriptPath)}, resumeFromRunId: ${JSON.stringify(runId)}})`
		: `workflow({script: <the script>, resumeFromRunId: ${JSON.stringify(runId)}})`
}

/** The file name only, for a line a person reads. */
export function shortName(path: string): string {
	return basename(path)
}
