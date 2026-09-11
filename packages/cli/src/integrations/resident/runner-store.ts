import { randomBytes, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { type ProjectId, ResidentConflictError, type TenantId, isEntityId } from '@namzu/sdk'

import { publishPrivateJsonIfAbsent } from '../state/immutable-json.js'
import { ensurePrivateStateDirectory } from '../state/private-directory.js'
import type { CliResident } from './storage.js'

export interface RunnerRecord {
	readonly version: 1
	readonly revision: number
	readonly instanceId: string
	readonly tenantId: TenantId
	readonly projectId: ProjectId
	readonly agentKey: string
	readonly cwd: string
	readonly mode: 'foreground' | 'background'
	readonly phase: 'reserved' | 'running' | 'stopped' | 'released'
	readonly reservedAt: number
	readonly maxSteps: number
	readonly pauseGeneration: number
	readonly pid: number | null
	readonly port: number | null
	/** Private authentication material; never include this in status output. */
	readonly token: string
	readonly endedAt: number | null
	readonly outcome: string | null
}

export interface ReserveRunnerOptions {
	readonly mode: RunnerRecord['mode']
	readonly maxSteps: number
	readonly pauseGeneration: number
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const REVISION_NAME = /^([1-9][0-9]{0,15})\.json$/u
const FIELDS = [
	'version',
	'revision',
	'instanceId',
	'tenantId',
	'projectId',
	'agentKey',
	'cwd',
	'mode',
	'phase',
	'reservedAt',
	'maxSteps',
	'pauseGeneration',
	'pid',
	'port',
	'token',
	'endedAt',
	'outcome',
] as const

function integer(value: unknown, minimum: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function canonicalPath(value: string): boolean {
	return !value.includes('\0') && isAbsolute(value) && resolve(value) === value
}

function location(resident: CliResident): { base: string; runner: string; revisions: string } {
	if (
		!isEntityId(resident.tenantId, 'tenant') ||
		!isEntityId(resident.projectId, 'project') ||
		!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(resident.agentKey) ||
		!canonicalPath(resident.root) ||
		!canonicalPath(resident.cwd)
	) {
		throw new Error('Invalid resident scope for runner ownership.')
	}
	const base = join(
		resident.root,
		'projects',
		resident.projectId,
		'cli',
		'residents',
		resident.agentKey,
	)
	if (resident.artifactsRoot !== join(base, 'attempts')) {
		throw new Error('Resident runner path does not match its bound project and agent.')
	}
	return { base, runner: join(base, 'runner'), revisions: join(base, 'runner', 'revisions') }
}

function realDirectory(path: string): boolean {
	try {
		const entry = lstatSync(path)
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`Resident runner state requires a real directory: ${path}`)
		}
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
		throw error
	}
}

function revisions(resident: CliResident): number[] {
	const paths = location(resident)
	let current = resident.root
	if (!realDirectory(current)) return []
	for (const segment of [
		'projects',
		resident.projectId,
		'cli',
		'residents',
		resident.agentKey,
		'runner',
		'revisions',
	]) {
		current = join(current, segment)
		if (!realDirectory(current)) return []
	}
	const numbers: number[] = []
	for (const entry of readdirSync(paths.revisions, { withFileTypes: true })) {
		// Publication scratch names never establish ownership, even after a crash.
		if (/^[1-9][0-9]{0,15}\.json\.candidate\.[0-9a-f-]+$/u.test(entry.name)) continue
		const match = REVISION_NAME.exec(entry.name)
		const revision = match ? Number(match[1]) : Number.NaN
		if (!integer(revision, 1) || !entry.isFile() || entry.isSymbolicLink()) {
			throw new Error(
				`Invalid resident runner revision entry: ${join(paths.revisions, entry.name)}`,
			)
		}
		numbers.push(revision)
	}
	return numbers.sort((left, right) => right - left)
}

function checked(resident: CliResident, raw: unknown, revision: number): RunnerRecord {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error('Resident runner record must be an object.')
	}
	const value = raw as Record<string, unknown>
	if (Object.keys(value).length !== FIELDS.length || FIELDS.some((field) => !(field in value))) {
		throw new Error('Resident runner record has missing or unsupported fields.')
	}
	if (
		value.version !== 1 ||
		value.revision !== revision ||
		!integer(value.revision, 1) ||
		typeof value.instanceId !== 'string' ||
		!UUID.test(value.instanceId) ||
		value.tenantId !== resident.tenantId ||
		value.projectId !== resident.projectId ||
		value.agentKey !== resident.agentKey ||
		value.cwd !== resident.cwd ||
		(value.mode !== 'foreground' && value.mode !== 'background') ||
		!['reserved', 'running', 'stopped', 'released'].includes(String(value.phase)) ||
		!integer(value.reservedAt, 0) ||
		!integer(value.maxSteps, 1) ||
		!integer(value.pauseGeneration, 0) ||
		(value.pid !== null && !integer(value.pid, 1)) ||
		(value.port !== null && (!integer(value.port, 1) || value.port > 65_535)) ||
		typeof value.token !== 'string' ||
		!/^[0-9a-f]{64}$/u.test(value.token)
	) {
		throw new Error('Resident runner version, revision, scope or ownership metadata is invalid.')
	}
	const terminal = value.phase === 'stopped' || value.phase === 'released'
	if (
		(terminal
			? !integer(value.endedAt, 0) ||
				typeof value.outcome !== 'string' ||
				!value.outcome.trim() ||
				value.outcome.length > 8_000
			: value.endedAt !== null || value.outcome !== null) ||
		(value.phase === 'reserved' && (value.pid !== null || value.port !== null)) ||
		(value.phase === 'running' && value.pid === null) ||
		(value.pid === null && value.port !== null) ||
		(value.mode === 'background' && value.pid !== null && value.port === null)
	) {
		throw new Error('Resident runner phase and process metadata disagree.')
	}
	return Object.freeze(value as unknown as RunnerRecord)
}

function readRevision(resident: CliResident, revision: number): RunnerRecord {
	const path = join(location(resident).revisions, `${revision}.json`)
	try {
		const entry = lstatSync(path)
		if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 64 * 1024) {
			throw new Error('expected a bounded regular file without a symbolic link')
		}
		return checked(resident, JSON.parse(readFileSync(path, 'utf8')), revision)
	} catch (error) {
		// JSON.parse diagnostics can quote private record bytes, including the
		// control token. Keep filesystem/schema details, never parser excerpts.
		const detail =
			error instanceof SyntaxError
				? 'invalid JSON'
				: error instanceof Error
					? error.message
					: 'unknown read failure'
		throw new Error(
			`Cannot read resident runner revision ${path}: ${detail}. Refusing ownership recovery from damaged state.`,
		)
	}
}

/** An absent runner is a read-only result, never an instruction to initialize it. */
export function readRunner(resident: CliResident): RunnerRecord | null {
	const head = revisions(resident)[0]
	return head === undefined ? null : readRevision(resident, head)
}

/** The original runner's final evidence remains visible after a successor starts. */
export function readRunnerInstance(resident: CliResident, instanceId: string): RunnerRecord | null {
	if (!UUID.test(instanceId)) throw new Error('Invalid resident runner instance ID.')
	for (const revision of revisions(resident)) {
		const record = readRevision(resident, revision)
		if (record.instanceId === instanceId) return record
	}
	return null
}

function publish(
	resident: CliResident,
	expected: RunnerRecord | null,
	propose: (revision: number) => RunnerRecord,
): RunnerRecord {
	const current = readRunner(resident)
	if (!isDeepStrictEqual(current, expected)) throw new ResidentConflictError()
	const next = (current?.revision ?? 0) + 1
	if (!integer(next, 1)) throw new Error('Resident runner revision overflow.')
	const record = checked(resident, propose(next), next)
	const paths = location(resident)
	if (!realDirectory(paths.base)) throw new Error('Resident binding directory is missing.')
	const runner = ensurePrivateStateDirectory(paths.base, 'runner')
	const directory = ensurePrivateStateDirectory(runner, 'revisions')
	publishPrivateJsonIfAbsent(join(directory, `${next}.json`), record)
	// The helper reports EEXIST by preserving the winner. Equality proves whose
	// complete proposal was published; never retry a stale operation on that owner.
	if (!isDeepStrictEqual(readRevision(resident, next), record)) throw new ResidentConflictError()
	return record
}

/** Reserve one explicitly authorized invocation; an occupied owner is never stolen. */
export function reserveRunner(resident: CliResident, options: ReserveRunnerOptions): RunnerRecord {
	if (
		(options.mode !== 'foreground' && options.mode !== 'background') ||
		!integer(options.maxSteps, 1) ||
		!integer(options.pauseGeneration, 0)
	) {
		throw new Error('Invalid resident runner invocation limits or mode.')
	}
	const current = readRunner(resident)
	if (current && current.phase !== 'stopped' && current.phase !== 'released') {
		throw new ResidentConflictError()
	}
	return publish(resident, current, (revision) => ({
		version: 1,
		revision,
		instanceId: randomUUID(),
		tenantId: resident.tenantId,
		projectId: resident.projectId,
		agentKey: resident.agentKey,
		cwd: resident.cwd,
		mode: options.mode,
		phase: 'reserved',
		reservedAt: Date.now(),
		maxSteps: options.maxSteps,
		pauseGeneration: options.pauseGeneration,
		pid: null,
		port: null,
		token: randomBytes(32).toString('hex'),
		endedAt: null,
		outcome: null,
	}))
}

export function attachRunning(
	resident: CliResident,
	expected: RunnerRecord,
	process: { readonly pid: number; readonly port: number | null },
): RunnerRecord {
	if (expected.phase !== 'reserved') throw new ResidentConflictError()
	return publish(resident, expected, (revision) => ({
		...expected,
		revision,
		phase: 'running',
		pid: process.pid,
		port: process.port,
	}))
}

/** Publish only after the executor and its controls have drained. */
export function finishRunner(
	resident: CliResident,
	expected: RunnerRecord,
	outcome: string,
): RunnerRecord {
	if (expected.phase !== 'reserved' && expected.phase !== 'running') {
		throw new ResidentConflictError()
	}
	return publish(resident, expected, (revision) => ({
		...expected,
		revision,
		phase: 'stopped',
		endedAt: Date.now(),
		outcome,
	}))
}

/** Explicit operator recovery of an exact owner; this is never proof of drainage. */
export function releaseRunner(resident: CliResident, expected: RunnerRecord): RunnerRecord {
	if (expected.phase !== 'reserved' && expected.phase !== 'running') {
		throw new ResidentConflictError()
	}
	return publish(resident, expected, (revision) => ({
		...expected,
		revision,
		phase: 'released',
		endedAt: Date.now(),
		outcome: 'Operator explicitly released this owner after inspecting stopped executors.',
	}))
}

/** Status reports retain ownership evidence without disclosing the control nonce. */
export function publicRunner(record: RunnerRecord): Omit<RunnerRecord, 'token'> {
	return {
		version: record.version,
		revision: record.revision,
		instanceId: record.instanceId,
		tenantId: record.tenantId,
		projectId: record.projectId,
		agentKey: record.agentKey,
		cwd: record.cwd,
		mode: record.mode,
		phase: record.phase,
		reservedAt: record.reservedAt,
		maxSteps: record.maxSteps,
		pauseGeneration: record.pauseGeneration,
		pid: record.pid,
		port: record.port,
		endedAt: record.endedAt,
		outcome: record.outcome,
	}
}
