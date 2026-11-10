/**
 * The turn's outcome record: what changed in the workspace, what was run to
 * check it, and whether the last word of each check was said about the
 * workspace as the turn left it.
 *
 * It is derived from the turn's own tool calls and, when the host supplies a
 * change detector, from the workspace itself. Never from what the model says.
 * Nothing here blocks or prolongs a turn; the completion audit keeps its own
 * rule. Every uncertainty is reported as uncertainty: a check whose exit status
 * something else may have decided is `masked`, not `passed`; a detector that
 * cannot answer is `null`, never a match.
 */

import { isReadOnlyCommandLine } from '../../../authorization/readonly-commands.js'
import { lexShellCommandLine } from '../../../authorization/shell-lexer.js'
import {
	OUTCOME_DEFAULT_DETECT_TIMEOUT_MS,
	OUTCOME_MAX_CHECKS,
	OUTCOME_MAX_COMMAND_CHARS,
	OUTCOME_MAX_PATHS,
	OUTCOME_MAX_PATH_CHARS,
	type TurnOutcome,
	type TurnOutcomeCheck,
	type TurnOutcomeCheckResult,
	type TurnOutcomeConfig,
	type TurnOutcomeVerdict,
} from '../../../types/session/outcome.js'
import type { ToolFacts } from '../../../types/tool/index.js'
import { WRITING_TOOLS, isVerificationCommand } from './completion-audit.js'

/** A finished tool call as the ledger sees it. */
export interface OutcomeCall {
	readonly toolName: string
	/** The call's parsed input, when it had one. */
	readonly input?: unknown
	readonly isError?: boolean
	/** A hook stopped it before it ran. */
	readonly skipped?: boolean
	/** The tool declared this call read-only (or it only keeps the task list). */
	readonly readOnly?: boolean
	/** What the call did, as typed fields. Absent when a hook replaced the output. */
	readonly facts?: ToolFacts
}

/** A call about to run: enough to tell whether it could change the workspace. */
export interface PendingOutcomeCall {
	readonly toolName: string
	readonly input?: unknown
	readonly readOnly?: boolean
}

/** Beyond these the ledger counts but no longer remembers. */
const MAX_REMEMBERED_PATHS = 1000
const MAX_REMEMBERED_CHECKS = 200

/** Programs that print or search text. A line that only names a check to one of them does not run it. */
const NOT_A_RUNNER = new Set([
	'echo',
	'printf',
	'cat',
	'grep',
	'rg',
	'sed',
	'awk',
	'head',
	'tail',
	'less',
	'more',
	'man',
	'which',
	'type',
	'command',
	'ls',
	'find',
	'wc',
	'true',
	'false',
	'test',
	'[',
	':',
])

const SNAPSHOT_VERSION = 1

interface CheckState {
	key: string
	command: string
	step: number
	result: TurnOutcomeCheckResult
	exitCode?: number
	/** A successful write tool call came after this run. */
	afterWrite: boolean
	/** A call that could change the workspace, and is not a write tool, came after this run. */
	afterUnknown: boolean
	/** The fingerprint taken when it finished; `null` when it could not be taken or was not trustworthy. */
	fingerprint: string | null | undefined
}

/** The part of the ledger a checkpoint keeps, so a resumed turn does not forget what came before it. */
export interface OutcomeLedgerSnapshot {
	readonly v: typeof SNAPSHOT_VERSION
	readonly started: boolean
	readonly startFingerprint: string | null
	readonly paths: readonly string[]
	readonly writes: number
	readonly checks: readonly {
		readonly key: string
		readonly command: string
		readonly step: number
		readonly result: TurnOutcomeCheckResult
		readonly exitCode?: number
		readonly afterWrite: boolean
		readonly afterUnknown: boolean
		readonly fingerprint: string | null
	}[]
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text
}

function normalise(command: string): string {
	return command.trim().replace(/\s+/g, ' ')
}

function commandOf(input: unknown): string | undefined {
	const command = (input as { command?: unknown } | undefined)?.command
	return typeof command === 'string' ? command : undefined
}

function pathOf(call: OutcomeCall): string | undefined {
	if (call.facts?.kind === 'edit' || call.facts?.kind === 'write') {
		if (call.facts.path !== undefined) return call.facts.path
	}
	const input = call.input as Record<string, unknown> | undefined
	for (const key of ['path', 'file_path', 'filePath', 'notebook_path']) {
		const value = input?.[key]
		if (typeof value === 'string' && value !== '') return value
	}
	return undefined
}

/**
 * Whether the line's exit status is its last check's own: every command of the
 * line is a plain command, joined to the others only by `&&`, with nothing
 * before the first, and nothing after the last but a closing `;`. A pipe, a
 * `;` between commands, `||`, a trailing `&`, a group, a nested shell or
 * anything the lexer cannot read to the end lets something else decide the
 * status, and the answer is no. `a && b` exits 0 only when both did.
 *
 * The bash tool does not set `pipefail`, so `pnpm test | tail` exits with
 * `tail`'s status.
 */
function exitStatusIsOwn(line: string): boolean {
	const lexed = lexShellCommandLine(line)
	if (!lexed.complete || lexed.opaque || lexed.commands.length === 0) return false
	if (lexed.compoundWords.length > 0) return false
	let cursor = 0
	for (const [index, command] of lexed.commands.entries()) {
		if (command.origin !== 'line' || command.depth !== 0) return false
		const at = line.indexOf(command.text, cursor)
		if (at < 0) return false
		const gap = line.slice(cursor, at).trim()
		if (index === 0 ? gap !== '' : gap !== '&&') return false
		cursor = at + command.text.length
	}
	const tail = line.slice(cursor).trim()
	return tail === '' || tail === ';'
}

/** Whether some simple command of the line is a recognised check that is not merely named. */
function runsRecognisedCheck(line: string, hostIsCheck?: (command: string) => boolean): boolean {
	const named = (text: string): boolean => {
		if (isVerificationCommand(text)) return true
		try {
			return hostIsCheck?.(text) === true
		} catch {
			return false
		}
	}
	const lexed = lexShellCommandLine(line)
	if (!lexed.complete || lexed.opaque) return named(line)
	for (const command of lexed.commands) {
		const head = command.words[command.assignments]
		const program = head === undefined ? '' : (head.value.split('/').pop() ?? head.value)
		if (NOT_A_RUNNER.has(program)) continue
		if (named(command.text)) return true
	}
	return false
}

export class OutcomeLedger {
	private readonly config: TurnOutcomeConfig
	private started = false
	private startFingerprint: string | null = null
	private readonly paths = new Set<string>()
	private extraPaths = 0
	private writes = 0
	private readonly checks = new Map<string, CheckState>()
	private unrecorded = false
	private settled: TurnOutcome | undefined

	constructor(config: TurnOutcomeConfig = {}) {
		this.config = config
	}

	/** False once the record is known to be missing what came before a resume. */
	get recorded(): boolean {
		return !this.unrecorded
	}

	/**
	 * The turn resumed from a checkpoint that carries no ledger. What happened
	 * before it is unknown, and a record that began as `unchanged` would be a
	 * lie, so the turn reports no outcome at all.
	 */
	markUnrecorded(): void {
		this.unrecorded = true
	}

	/** Take back what a checkpoint kept. A snapshot that does not parse leaves the turn unrecorded. */
	restore(snapshot: unknown): void {
		const parsed = parseSnapshot(snapshot)
		if (parsed === undefined) {
			this.unrecorded = true
			return
		}
		this.started = parsed.started
		this.startFingerprint = parsed.startFingerprint
		for (const path of parsed.paths) this.paths.add(path)
		this.writes = parsed.writes
		this.checks.clear()
		for (const check of parsed.checks) {
			this.checks.set(check.key, { ...check, fingerprint: check.fingerprint })
		}
	}

	/** What a checkpoint should keep. */
	snapshot(): OutcomeLedgerSnapshot {
		return {
			v: SNAPSHOT_VERSION,
			started: this.started,
			startFingerprint: this.startFingerprint,
			paths: [...this.paths],
			writes: this.writes,
			checks: [...this.checks.values()].map((check) => ({
				key: check.key,
				command: check.command,
				step: check.step,
				result: check.result,
				...(check.exitCode !== undefined ? { exitCode: check.exitCode } : {}),
				afterWrite: check.afterWrite,
				afterUnknown: check.afterUnknown,
				fingerprint: check.fingerprint ?? null,
			})),
		}
	}

	/**
	 * Whether the call could change the workspace. Anything not provably
	 * read-only counts: a tool that does not say, a shell line that is not on
	 * the read-only list.
	 */
	private couldChange(call: PendingOutcomeCall): boolean {
		if (call.readOnly === true) return false
		if (call.toolName === 'bash') {
			const command = commandOf(call.input)
			if (command !== undefined && isReadOnlyCommandLine(command)) return false
		}
		return true
	}

	private async detect(): Promise<string | null> {
		const detect = this.config.detectChanges
		if (detect === undefined) return null
		const deadline = this.config.detectTimeoutMs ?? OUTCOME_DEFAULT_DETECT_TIMEOUT_MS
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			const asked = Promise.resolve().then(detect)
			// A detector that settles after its deadline must not surface later.
			asked.catch(() => {})
			const late = new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), deadline)
			})
			const answer = await Promise.race([asked, late])
			return typeof answer === 'string' ? answer : null
		} catch {
			return null
		} finally {
			if (timer !== undefined) clearTimeout(timer)
		}
	}

	/**
	 * Called with a step's calls before any of them runs. The first call of the
	 * turn that could change the workspace takes the starting fingerprint; a turn
	 * of provably read-only calls never asks the detector anything.
	 */
	async before(calls: readonly PendingOutcomeCall[]): Promise<void> {
		if (this.started || this.config.detectChanges === undefined) return
		if (!calls.some((call) => this.couldChange(call))) return
		this.started = true
		this.startFingerprint = await this.detect()
	}

	/** Feed the calls of one finished step, in order. */
	async observe(step: number, calls: readonly OutcomeCall[]): Promise<void> {
		// Checks that finished in this step with nothing after them that could
		// change the workspace: the detector, asked once at the end of the step,
		// answers for exactly the state they left.
		let pending: CheckState[] = []
		for (const call of calls) {
			if (call.skipped === true) continue
			const written = WRITING_TOOLS.has(call.toolName)
			if (written && call.isError !== true) {
				if (call.facts?.kind === 'write' && call.facts.operation === 'unchanged') continue
				this.recordWrite(call)
				this.afterEveryCheck('write')
				for (const check of pending) check.fingerprint = null
				pending = []
				continue
			}
			if (written) continue
			const command = call.toolName === 'bash' ? commandOf(call.input) : undefined
			if (command !== undefined && runsRecognisedCheck(command, this.config.isCheck)) {
				this.afterEveryCheck('other')
				for (const check of pending) check.fingerprint = null
				pending = []
				pending.push(this.recordCheck(step, command, call))
				continue
			}
			if (this.couldChange(call)) {
				this.afterEveryCheck('other')
				for (const check of pending) check.fingerprint = null
				pending = []
			}
		}
		if (pending.length > 0 && this.started && this.startFingerprint !== null) {
			const fingerprint = await this.detect()
			for (const check of pending) check.fingerprint = fingerprint
		}
	}

	private afterEveryCheck(kind: 'write' | 'other'): void {
		for (const check of this.checks.values()) {
			if (kind === 'write') check.afterWrite = true
			else check.afterUnknown = true
		}
	}

	private recordWrite(call: OutcomeCall): void {
		this.writes += 1
		const path = pathOf(call)
		if (path === undefined) return
		const clipped = clip(path, OUTCOME_MAX_PATH_CHARS)
		if (this.paths.has(clipped)) return
		if (this.paths.size >= MAX_REMEMBERED_PATHS) {
			this.extraPaths += 1
			return
		}
		this.paths.add(clipped)
	}

	private recordCheck(step: number, command: string, call: OutcomeCall): CheckState {
		const key = normalise(command)
		const { result, exitCode } = this.judge(command, call)
		const state: CheckState = {
			key,
			command: clip(key, OUTCOME_MAX_COMMAND_CHARS),
			step,
			result,
			...(exitCode !== undefined ? { exitCode } : {}),
			afterWrite: false,
			afterUnknown: false,
			// Not asked for yet: `undefined` until the step's detector call answers.
			fingerprint: undefined,
		}
		// Latest run of each distinct command, ordered by when it last ran.
		this.checks.delete(key)
		this.checks.set(key, state)
		if (this.checks.size > MAX_REMEMBERED_CHECKS) {
			// A failing check is never the one forgotten.
			for (const [candidate, held] of this.checks) {
				if (held.result !== 'failed' && candidate !== key) {
					this.checks.delete(candidate)
					break
				}
			}
		}
		return state
	}

	private judge(
		command: string,
		call: OutcomeCall,
	): { result: TurnOutcomeCheckResult; exitCode?: number } {
		const facts = call.facts
		if (facts?.kind === 'failure') return { result: 'failed' }
		if (facts?.kind !== 'command') {
			// No typed record of the run: a hook replaced the output. An error is
			// still an error; anything else says nothing about the exit status.
			return { result: call.isError === true ? 'failed' : 'unsettled' }
		}
		const exitCode = facts.exitCode
		const withCode = exitCode !== undefined ? { exitCode } : {}
		if (facts.background === true || facts.continued === true || facts.timedOut === true) {
			return { result: 'unsettled', ...withCode }
		}
		if (exitCode === undefined) {
			return { result: call.isError === true ? 'failed' : 'unsettled' }
		}
		if (exitCode === 0) {
			if (call.isError === true) return { result: 'unsettled', exitCode }
			return { result: exitStatusIsOwn(command) ? 'passed' : 'masked', exitCode }
		}
		if (!exitStatusIsOwn(command)) return { result: 'masked', exitCode }
		// A non-zero exit the command's own answer (`grep` found nothing) is not a
		// failure, and not a pass either.
		if (facts.exitNote !== undefined && call.isError !== true) {
			return { result: 'unsettled', exitCode }
		}
		return { result: 'failed', exitCode }
	}

	/** The outcome, once, when the turn ends. `undefined` when the record is not whole. */
	async finish(): Promise<TurnOutcome | undefined> {
		if (this.unrecorded) return undefined
		if (this.settled !== undefined) return this.settled
		let endFingerprint: string | null = null
		if (this.started) endFingerprint = await this.detect()
		const outcome = this.compute(endFingerprint)
		this.settled = outcome
		return outcome
	}

	private compute(endFingerprint: string | null): TurnOutcome {
		const workspace = this.started && this.startFingerprint !== null && endFingerprint !== null
		const moved = workspace && this.startFingerprint !== endFingerprint
		// A write tool that succeeded changed something, even a file the detector
		// cannot see (an ignored one). Counting it is the cautious direction.
		const changed = this.writes > 0 || moved

		const all = [...this.checks.values()]
		const freshOf = (check: CheckState): boolean | undefined => {
			if (check.afterWrite) return false
			if (workspace && check.fingerprint !== undefined) {
				return check.fingerprint === null ? undefined : check.fingerprint === endFingerprint
			}
			return check.afterUnknown ? undefined : true
		}
		const rows = all.map((check) => ({ check, fresh: freshOf(check) }))

		let verdict: TurnOutcomeVerdict
		const passes = rows.filter((row) => row.check.result === 'passed')
		if (rows.some((row) => row.check.result === 'failed')) verdict = 'failing'
		else if (!changed) verdict = 'unchanged'
		else if (rows.length === 0) verdict = 'unchecked'
		else if (passes.some((row) => row.fresh === true)) verdict = 'checked'
		else if (passes.length > 0 && passes.every((row) => row.fresh === false)) verdict = 'stale'
		else verdict = 'inconclusive'

		const total = this.paths.size + this.extraPaths
		const kept = rows.slice(-OUTCOME_MAX_CHECKS)
		const checks: TurnOutcomeCheck[] = kept.map(({ check, fresh }) => ({
			command: check.command,
			step: check.step,
			result: check.result,
			...(check.exitCode !== undefined ? { exitCode: check.exitCode } : {}),
			...(fresh !== undefined ? { fresh } : {}),
		}))
		return {
			verdict,
			basis: workspace ? 'workspace' : 'calls',
			changes: {
				total,
				paths: [...this.paths].slice(0, OUTCOME_MAX_PATHS),
				outsideKnownTools: moved && this.writes === 0,
			},
			checks,
			...(rows.length > OUTCOME_MAX_CHECKS ? { checksTotal: rows.length } : {}),
		}
	}
}

function parseSnapshot(value: unknown): OutcomeLedgerSnapshot | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const snap = value as Record<string, unknown>
	if (snap.v !== SNAPSHOT_VERSION || typeof snap.started !== 'boolean') return undefined
	const start = snap.startFingerprint
	if (start !== null && typeof start !== 'string') return undefined
	if (!Array.isArray(snap.paths) || !snap.paths.every((p) => typeof p === 'string'))
		return undefined
	if (typeof snap.writes !== 'number' || !Number.isSafeInteger(snap.writes) || snap.writes < 0) {
		return undefined
	}
	if (!Array.isArray(snap.checks)) return undefined
	const results = new Set<string>(['passed', 'failed', 'masked', 'unsettled'])
	for (const raw of snap.checks) {
		if (typeof raw !== 'object' || raw === null) return undefined
		const c = raw as Record<string, unknown>
		if (
			typeof c.key !== 'string' ||
			typeof c.command !== 'string' ||
			typeof c.step !== 'number' ||
			typeof c.result !== 'string' ||
			!results.has(c.result) ||
			(c.exitCode !== undefined && typeof c.exitCode !== 'number') ||
			typeof c.afterWrite !== 'boolean' ||
			typeof c.afterUnknown !== 'boolean' ||
			(c.fingerprint !== null && typeof c.fingerprint !== 'string')
		) {
			return undefined
		}
	}
	return snap as unknown as OutcomeLedgerSnapshot
}
