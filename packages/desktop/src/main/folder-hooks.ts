import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import {
	type HookRow,
	type HooksReport,
	readHooksReport,
	safeRuns,
} from '../shared/hooks-report.js'
import { type AutoRunFinding, capped, inspectAutoRunSettings, plural } from './folder-settings.js'
import type { ComputerCliCommand, ComputerCliLease } from './pal-computer-cli.js'

/**
 * The folder trust dialog's list of what would start by itself, taken from the engine's own answer
 * to "what runs by itself in this folder" (`namzu hooks --cwd <folder> --json`). The engine reads
 * the folder's files as text and runs nothing, so asking about a folder nobody trusted is safe.
 * The dialog's own parser (`inspectAutoRunSettings`) stays as the fallback for an engine that does
 * not know the question, and then the dialog says its list may be incomplete.
 */

/** Asks the engine about one folder; nothing when the engine cannot answer. */
export type FolderHooksReader = (folder: string) => Promise<HooksReport | undefined>

type Spawn = (program: string, args: string[], options: SpawnOptions) => ChildProcess

const OUTPUT_LIMIT = 8 * 1024 * 1024
export const FOLDER_HOOKS_TIMEOUT_MS = 20_000

/** Runs the engine's own `hooks` command as a short process, so no host is started in the folder. */
export function createFolderHooksReader(
	command: ComputerCliCommand | (() => Promise<ComputerCliLease>),
	options: { spawnProcess?: Spawn; timeoutMs?: number } = {},
): FolderHooksReader {
	const spawnProcess = options.spawnProcess ?? spawn
	const timeoutMs = options.timeoutMs ?? FOLDER_HOOKS_TIMEOUT_MS
	const run = (held: ComputerCliCommand, folder: string): Promise<HooksReport | undefined> =>
		new Promise((done) => {
			let child: ChildProcess
			try {
				child = spawnProcess(held.program, [...held.prefix, 'hooks', `--cwd=${folder}`, '--json'], {
					env: held.env,
					windowsHide: true,
					stdio: ['ignore', 'pipe', 'ignore'],
				})
			} catch {
				done(undefined)
				return
			}
			let text = ''
			let settled = false
			let timer: ReturnType<typeof setTimeout> | undefined = undefined
			const finish = (value: HooksReport | undefined, stop: boolean) => {
				if (settled) return
				settled = true
				if (timer) clearTimeout(timer)
				if (stop) {
					try {
						child.kill()
					} catch {
						// Already gone.
					}
				}
				done(value)
			}
			child.stdout?.setEncoding?.('utf8')
			child.stdout?.on('data', (chunk: string | Buffer) => {
				text += String(chunk)
				if (text.length > OUTPUT_LIMIT) finish(undefined, true)
			})
			timer = setTimeout(() => finish(undefined, true), timeoutMs)
			timer.unref?.()
			child.once('error', () => finish(undefined, false))
			child.once('close', (exitCode: number | null) =>
				finish(exitCode === 0 ? parseHooksOutput(text) : undefined, false),
			)
		})
	if (typeof command === 'function') {
		return async (folder) => {
			let held: ComputerCliLease | undefined
			try {
				held = await command()
				return await run(held, folder)
			} catch {
				return undefined
			} finally {
				held?.release?.()
			}
		}
	}
	return (folder) => run(command, folder)
}

/** The answer is one JSON value; anything printed around it is ignored. */
export function parseHooksOutput(text: string): HooksReport | undefined {
	const trimmed = text.trim()
	if (!trimmed) return undefined
	const candidates = [
		trimmed,
		...trimmed
			.split('\n')
			.reverse()
			.filter((line) => line.trim()),
	]
	for (const candidate of candidates) {
		try {
			const report = readHooksReport(JSON.parse(candidate))
			if (report) return report
		} catch {
			// Not the answer; try the next line.
		}
	}
	return undefined
}

const expandHome = (path: string): string =>
	path === '~' || path.startsWith('~/') || path.startsWith('~\\')
		? `${homedir()}${path.slice(1)}`
		: path

/**
 * Whether a hook starts because of this folder: its own files (`project`, `local`), anything the
 * engine holds back until the folder is trusted, or a source that lives under the folder. Where
 * these disagree the row is counted in, since a list that is too long costs a person a glance and
 * one that is too short costs them the warning.
 */
export function startsInFolder(row: HookRow, folder: string): boolean {
	if (row.why?.code === 'folder-not-trusted') return true
	if (row.origin.scope === 'project' || row.origin.scope === 'local') return true
	if (!row.origin.path) return false
	const root = resolve(folder)
	const path = resolve(expandHome(row.origin.path))
	return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function sourceWords(row: HookRow): string {
	switch (row.origin.kind) {
		case 'plugin':
			return `the plugin ${row.origin.name ?? row.origin.label.replace(/^plugin /, '')}`
		case 'skill':
			return `the skill ${row.origin.name ?? row.origin.label.replace(/^skill /, '')} (when it is used)`
		case 'agent':
			return `the agent file ${row.origin.name ?? row.origin.label.replace(/^agent /, '')} (when it runs)`
		default:
			return row.origin.label
	}
}

function hookLine(row: HookRow): string {
	// The words the dialog has always used for an event ("pre tool use"), then what it starts.
	const event = row.event.replace(/_/g, ' ')
	const what = `${row.type === 'prompt' ? 'asks the model: ' : ''}${safeRuns(row.runs)}`
	const matcher = row.matcher ? ` · matches ${row.matcher}` : ''
	const off = row.state === 'off' ? ` · off now: ${row.why?.text ?? 'switched off'}` : ''
	return `${event}: ${what}${matcher}${off}`
}

/** One finding per source, in the order the engine listed them, then what could not be loaded. */
export function findingsFromReport(report: HooksReport, folder: string): AutoRunFinding[] {
	const bySource = new Map<string, { words: string; rows: HookRow[] }>()
	for (const row of report.hooks) {
		if (!startsInFolder(row, folder)) continue
		const key = `${row.origin.kind}\u0000${row.origin.label}`
		const group = bySource.get(key) ?? { words: sourceWords(row), rows: [] }
		group.rows.push(row)
		bySource.set(key, group)
	}
	const found: AutoRunFinding[] = []
	for (const { words, rows } of bySource.values())
		found.push({
			label: `${plural(rows.length, 'hook', 'hooks')} from ${words}`,
			title: `Hooks from ${words}`,
			lines: capped(rows.map(hookLine), rows.length),
		})
	const lost = report.problems.filter(
		(problem) =>
			problem.severity === 'problem' &&
			(problem.inactive === 'folder-not-trusted' ||
				problem.origin.scope === 'project' ||
				problem.origin.scope === 'local'),
	)
	if (lost.length > 0)
		found.push({
			label: `${plural(lost.length, 'hook entry', 'hook entries')} in this folder that could not be loaded`,
			title: 'Hooks that could not be loaded',
			lines: capped(
				lost.map((problem) => `${problem.origin.label}: ${problem.message}`),
				lost.length,
			),
		})
	return found
}

/** The title the dialog's own parser gives its line about `hooks`; the engine's answer replaces it. */
const OWN_HOOKS_TITLE = 'Commands that run by themselves'

export interface FolderFindings {
	found: AutoRunFinding[]
	/** The engine could not list the folder's hooks, so the list may leave some out. */
	incomplete?: true
}

/** Everything that would start by itself in `folder`, from the engine's answer or else the dialog's own reading. */
export async function inspectFolderWithHooks(
	folder: string,
	read: FolderHooksReader,
): Promise<FolderFindings> {
	const [own, report] = await Promise.all([
		inspectAutoRunSettings(folder),
		read(folder).catch(() => undefined),
	])
	if (!report) return { found: own, incomplete: true }
	return {
		found: [
			...own.filter((item) => item.title !== OWN_HOOKS_TITLE),
			...findingsFromReport(report, folder),
		],
	}
}
