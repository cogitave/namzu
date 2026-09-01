import { constants, type Stats } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'

import { DiskSessionStore, UNKNOWN_TENANT_ID } from '@namzu/sdk'

const MAX_METADATA_BYTES = 4 * 1024 * 1024
const MAX_ORIGIN_BYTES = 64 * 1024
const MAX_REPORTED_ISSUES = 100
const MAX_ENTRIES = 100_000

const AUTHORED_TOP_LEVEL = new Set(['commands', 'plugins', 'skills'])
const CONFIG_TOP_LEVEL = new Set([
	'config.yaml',
	'credentials.json',
	'preferences.json',
	'trust.json',
])
const RUNTIME_TOP_LEVEL = new Set([
	'attachments',
	'cli.json',
	'desktop-sessions.json',
	'feedback',
	'goals',
	'memory',
	'projects',
	'tenants',
	'titles.json',
	'worktrees',
])
const CONTROL_TOP_LEVEL = new Set(['.migration'])
const PRIVATE_BOUNDARIES = ['attachments', 'goals', 'memory', 'projects', 'tenants'] as const

export type StateCategory =
	| 'authored'
	| 'configuration'
	| 'runtime'
	| 'control'
	| 'transient'
	| 'unknown'

export interface StateMeasure {
	readonly files: number
	readonly logicalBytes: number
}

export interface StateIssue {
	readonly code:
		| 'corrupt_metadata'
		| 'entry_changed'
		| 'inspection_skipped'
		| 'owner_mismatch'
		| 'permission_denied'
		| 'symlink_not_followed'
		| 'unsupported_entry'
		| 'unreadable'
	readonly path: string
	readonly detail: string
}

export interface StatePrivacyBoundary {
	readonly path: string
	readonly status: 'secure' | 'insecure' | 'unknown'
	readonly detail: string
}

export interface StateInventory {
	readonly sessions: StateMeasure & {
		readonly directories: number
		readonly invalidOrMissingRecords: number
	}
	readonly originOnlySessionCandidates: StateMeasure & {
		readonly complete: boolean
		readonly limitation: string
	}
	readonly runs: StateMeasure & {
		readonly directories: number
		readonly invalidOrMissingRecords: number
	}
	readonly checkpointFiles: StateMeasure
	readonly emergencyDumpFiles: StateMeasure
	readonly attachments: StateMeasure & {
		readonly pairs: number
		readonly orphanedDataFiles: number
		readonly orphanedTypeFiles: number
	}
}

export type ProjectBinding =
	| { readonly status: 'uninitialized'; readonly detail: string }
	| { readonly status: 'missing-pointer'; readonly detail: string }
	| { readonly status: 'invalid-pointer'; readonly detail: string }
	| {
			readonly status: 'missing-project'
			readonly projectId: string
			readonly detail: string
	  }
	| {
			readonly status: 'corrupt-project'
			readonly projectId: string
			readonly detail: string
	  }
	| {
			readonly status: 'legacy-unbound'
			readonly projectId: string
			readonly detail: string
	  }
	| {
			readonly status: 'root-mismatch'
			readonly projectId: string
			readonly recordedRoot: string
			readonly detail: string
	  }
	| {
			readonly status: 'bound'
			readonly projectId: string
			readonly detail: string
	  }
	| { readonly status: 'split'; readonly detail: string }
	| { readonly status: 'unknown'; readonly detail: string }

export interface StateRootReport {
	readonly path: string
	readonly roles: readonly ('project' | 'user')[]
	readonly exists: boolean
	readonly complete: boolean
	readonly files: number
	readonly directories: number
	readonly logicalBytes: number
	readonly categories: Readonly<Record<StateCategory, StateMeasure>>
	readonly inventory: StateInventory
	readonly privacy: readonly StatePrivacyBoundary[]
	readonly issues: readonly StateIssue[]
	readonly omittedIssues: number
}

export interface NamzuStateReport {
	readonly version: 1
	readonly readOnly: true
	readonly snapshot: {
		readonly consistency: 'best-effort-unlocked'
		readonly detail: string
	}
	readonly complete: boolean
	readonly scopeRoots: {
		readonly project: string
		readonly user: string
		readonly overlap: boolean
	}
	readonly physicalTotals: StateMeasure & { readonly roots: number }
	readonly roots: readonly StateRootReport[]
	readonly projectConfig: {
		readonly path: string
		readonly status: 'present' | 'absent' | 'unreadable' | 'unsupported'
		readonly logicalBytes: number
	}
	readonly projectBinding: ProjectBinding
}

interface Entry {
	readonly absolute: string
	readonly relative: string
	readonly kind: 'directory' | 'file' | 'symlink' | 'other'
	readonly size: number
	readonly device: number
	readonly inode: number
	readonly modifiedAt: number
	readonly mode: number
	readonly uid?: number
}

class EntryChangedError extends Error {}

interface MutableMeasure {
	files: number
	logicalBytes: number
}

interface IssueSink {
	readonly issues: StateIssue[]
	omitted: number
}

interface RootCollection {
	readonly root: string
	readonly exists: boolean
	readonly entries: readonly Entry[]
	readonly rootEntry?: Entry
	readonly issues: readonly StateIssue[]
	readonly omittedIssues: number
}

export interface InspectNamzuStateOptions {
	readonly cwd?: string
	readonly home?: string
	readonly env?: NodeJS.ProcessEnv
	readonly platform?: NodeJS.Platform
	readonly uid?: number
	/** Internal test seam; the production command uses the bounded default. */
	readonly entryLimit?: number
}

/**
 * Inspect Namzu's filesystem estate without changing it.
 *
 * Collection uses direct bounded filesystem reads. The one store object below
 * is used only for its read-only root-binding lookup; it does not create or
 * heal paths. A report about an untouched tree must leave that tree untouched.
 */
export async function inspectNamzuState(
	options: InspectNamzuStateOptions = {},
): Promise<NamzuStateReport> {
	const cwd = await canonicalBase(options.cwd ?? process.cwd())
	const home = await canonicalBase(options.home ?? homedir())
	const projectRoot = join(cwd, '.namzu')
	const environment = options.env ?? (options.home !== undefined ? {} : process.env)
	const configuredHome = environment.NAMZU_HOME
	const userRoot = await canonicalBase(
		configuredHome === undefined || configuredHome.length === 0
			? join(home, '.namzu')
			: configuredHome,
	)
	const overlap = projectRoot === userRoot
	const specs: Array<{ path: string; roles: Array<'project' | 'user'> }> = overlap
		? [{ path: projectRoot, roles: ['project', 'user'] }]
		: [
				{ path: projectRoot, roles: ['project'] },
				{ path: userRoot, roles: ['user'] },
			]

	const roots: StateRootReport[] = []
	const collections = new Map<string, RootCollection>()
	for (const spec of specs) {
		const collection = await collectRoot(
			spec.path,
			Math.max(1, Math.floor(options.entryLimit ?? MAX_ENTRIES)),
		)
		collections.set(spec.path, collection)
		roots.push(
			await projectRootReport(collection, spec.roles, {
				platform: options.platform ?? process.platform,
				uid: options.uid ?? process.getuid?.(),
			}),
		)
	}

	const physicalTotals = roots.reduce(
		(acc, root) => ({
			roots: acc.roots + (root.exists ? 1 : 0),
			files: acc.files + root.files,
			logicalBytes: acc.logicalBytes + root.logicalBytes,
		}),
		{ roots: 0, files: 0, logicalBytes: 0 },
	)
	const projectConfigPath = join(cwd, 'namzu.config.json')
	const projectConfig = await inspectOneRegularFile(projectConfigPath)
	const projectCollection = collections.get(projectRoot) as RootCollection
	const localBinding = await inspectProjectBinding(projectCollection, cwd)
	const centralBinding = await inspectCentralProjectBinding(userRoot, cwd)
	const projectBinding = combineProjectBindings(localBinding, centralBinding, projectRoot, userRoot)

	return {
		version: 1,
		readOnly: true,
		snapshot: {
			consistency: 'best-effort-unlocked',
			detail:
				'No writer lease is acquired. Metadata files are re-statted when inspected, but concurrent writers can change other counts after they are observed.',
		},
		complete:
			roots.every((root) => root.complete) &&
			projectBinding.status !== 'unknown' &&
			(projectConfig.status === 'present' || projectConfig.status === 'absent'),
		scopeRoots: { project: projectRoot, user: userRoot, overlap },
		physicalTotals,
		roots,
		projectConfig: {
			path: projectConfigPath,
			status: projectConfig.status,
			logicalBytes: projectConfig.logicalBytes,
		},
		projectBinding,
	}
}

function combineProjectBindings(
	local: ProjectBinding,
	central: ProjectBinding,
	localRoot: string,
	centralRoot: string,
): ProjectBinding {
	if (localRoot === centralRoot) {
		return central.status === 'uninitialized' ? local : central
	}
	if (local.status === 'uninitialized') return central
	if (central.status === 'uninitialized') return local
	if (central.status === 'unknown') return central
	if (central.status === 'bound') {
		return {
			status: 'split',
			detail: `Project-local state at ${localRoot} and central state at ${centralRoot} both claim this workspace. Namzu refuses to choose between them.`,
		}
	}
	return local
}

async function inspectCentralProjectBinding(
	centralRoot: string,
	canonicalCwd: string,
): Promise<ProjectBinding> {
	try {
		const project = await new DiskSessionStore({ rootDir: centralRoot }).findProjectByRootPath(
			canonicalCwd,
			UNKNOWN_TENANT_ID,
		)
		if (!project) {
			return {
				status: 'uninitialized',
				detail: 'No central Project is bound to this working directory.',
			}
		}
		return {
			status: 'bound',
			projectId: project.id,
			detail: `Central Project ${project.id} is bound to this working directory.`,
		}
	} catch (error) {
		return {
			status: 'unknown',
			detail: `The central Project binding could not be read safely: ${errorMessage(error)}`,
		}
	}
}

async function canonicalBase(path: string): Promise<string> {
	const absolute = resolve(path)
	try {
		return await realpath(absolute)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absolute
		return absolute
	}
}

async function inspectOneRegularFile(path: string): Promise<{
	readonly status: 'present' | 'absent' | 'unreadable' | 'unsupported'
	readonly logicalBytes: number
}> {
	try {
		const stat = await lstat(path)
		return stat.isFile()
			? { status: 'present', logicalBytes: stat.size }
			: { status: 'unsupported', logicalBytes: 0 }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { status: 'absent', logicalBytes: 0 }
		}
		return { status: 'unreadable', logicalBytes: 0 }
	}
}

async function collectRoot(root: string, entryLimit: number): Promise<RootCollection> {
	const sink: IssueSink = { issues: [], omitted: 0 }
	let rootStat: Stats
	try {
		rootStat = await lstat(root)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { root, exists: false, entries: [], issues: [], omittedIssues: 0 }
		}
		addIssue(sink, root, error)
		return {
			root,
			exists: true,
			entries: [],
			issues: sink.issues,
			omittedIssues: sink.omitted,
		}
	}
	if (rootStat.isSymbolicLink()) {
		pushIssue(sink, {
			code: 'symlink_not_followed',
			path: '.',
			detail: 'The state root is a symbolic link and was not followed.',
		})
		return {
			root,
			exists: true,
			entries: [],
			rootEntry: rootEntry(root, rootStat),
			issues: sink.issues,
			omittedIssues: sink.omitted,
		}
	}
	if (!rootStat.isDirectory()) {
		pushIssue(sink, {
			code: 'unsupported_entry',
			path: '.',
			detail: 'The state root exists but is not a directory.',
		})
		return {
			root,
			exists: true,
			entries: [],
			rootEntry: rootEntry(root, rootStat),
			issues: sink.issues,
			omittedIssues: sink.omitted,
		}
	}

	const entries: Entry[] = []
	await walk(root, '', entries, sink, entryLimit)
	return {
		root,
		exists: true,
		entries,
		rootEntry: rootEntry(root, rootStat),
		issues: sink.issues,
		omittedIssues: sink.omitted,
	}
}

function rootEntry(root: string, stat: Stats): Entry {
	return {
		absolute: root,
		relative: '.',
		kind: stat.isDirectory()
			? 'directory'
			: stat.isFile()
				? 'file'
				: stat.isSymbolicLink()
					? 'symlink'
					: 'other',
		size: stat.isFile() ? stat.size : 0,
		device: stat.dev,
		inode: stat.ino,
		modifiedAt: stat.mtimeMs,
		mode: stat.mode,
		...(typeof stat.uid === 'number' ? { uid: stat.uid } : {}),
	}
}

async function walk(
	root: string,
	relativeDir: string,
	entries: Entry[],
	sink: IssueSink,
	entryLimit: number,
): Promise<boolean> {
	const absoluteDir = relativeDir === '' ? root : join(root, relativeDir)
	const childDirectories: string[] = []
	try {
		const directory = await opendir(absoluteDir)
		for await (const child of directory) {
			const relativePath = relativeDir === '' ? child.name : join(relativeDir, child.name)
			if (entries.length >= entryLimit) {
				pushIssue(sink, {
					code: 'inspection_skipped',
					path: normalizeRelative(relativePath),
					detail: `Filesystem inventory reached its ${entryLimit}-entry memory bound; remaining entries were not counted.`,
				})
				return false
			}
			const absolute = join(root, relativePath)
			let stat: Awaited<ReturnType<typeof lstat>>
			try {
				stat = await lstat(absolute)
			} catch (error) {
				addIssue(sink, relativePath, error)
				continue
			}
			const entry: Entry = {
				absolute,
				relative: normalizeRelative(relativePath),
				kind: stat.isDirectory()
					? 'directory'
					: stat.isFile()
						? 'file'
						: stat.isSymbolicLink()
							? 'symlink'
							: 'other',
				size: stat.isFile() ? stat.size : 0,
				device: stat.dev,
				inode: stat.ino,
				modifiedAt: stat.mtimeMs,
				mode: stat.mode,
				...(typeof stat.uid === 'number' ? { uid: stat.uid } : {}),
			}
			entries.push(entry)
			if (entry.kind === 'directory') {
				childDirectories.push(relativePath)
			} else if (entry.kind === 'symlink') {
				pushIssue(sink, {
					code: 'symlink_not_followed',
					path: entry.relative,
					detail: 'Symbolic link was counted as an entry but its target was not read.',
				})
			} else if (entry.kind === 'other') {
				pushIssue(sink, {
					code: 'unsupported_entry',
					path: entry.relative,
					detail: 'Entry is not a regular file, directory, or symbolic link.',
				})
			}
		}
	} catch (error) {
		addIssue(sink, relativeDir || '.', error)
		return true
	}
	for (const childDirectory of childDirectories) {
		if (!(await walk(root, childDirectory, entries, sink, entryLimit))) return false
	}
	return true
}

function normalizeRelative(path: string): string {
	return sep === '/' ? path : path.split(sep).join('/')
}

function addIssue(sink: IssueSink, path: string, error: unknown): void {
	const code = (error as NodeJS.ErrnoException).code
	pushIssue(sink, {
		code: code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : 'unreadable',
		path: normalizeRelative(path),
		detail: error instanceof Error ? error.message : String(error),
	})
}

function pushIssue(sink: IssueSink, issue: StateIssue): void {
	if (sink.issues.length < MAX_REPORTED_ISSUES) sink.issues.push(issue)
	else sink.omitted += 1
}

async function projectRootReport(
	collection: RootCollection,
	roles: readonly ('project' | 'user')[],
	privacyContext: { readonly platform: NodeJS.Platform; readonly uid?: number },
): Promise<StateRootReport> {
	const categories: Record<StateCategory, MutableMeasure> = {
		authored: emptyMeasure(),
		configuration: emptyMeasure(),
		runtime: emptyMeasure(),
		control: emptyMeasure(),
		transient: emptyMeasure(),
		unknown: emptyMeasure(),
	}
	let files = 0
	let logicalBytes = 0
	let directories = 0
	for (const entry of collection.entries) {
		if (entry.kind === 'directory') directories += 1
		if (entry.kind !== 'file') continue
		files += 1
		logicalBytes += entry.size
		const category = categoryOf(entry.relative)
		categories[category].files += 1
		categories[category].logicalBytes += entry.size
	}

	const analysisSink: IssueSink = {
		issues: [...collection.issues],
		omitted: collection.omittedIssues,
	}
	const inventory = await inventoryOf(collection, analysisSink)
	const privacy = privacyOf(collection, privacyContext, analysisSink)

	return {
		path: collection.root,
		roles,
		exists: collection.exists,
		complete: analysisSink.issues.length === 0 && analysisSink.omitted === 0,
		files,
		directories,
		logicalBytes,
		categories,
		inventory,
		privacy,
		issues: analysisSink.issues,
		omittedIssues: analysisSink.omitted,
	}
}

function emptyMeasure(): MutableMeasure {
	return { files: 0, logicalBytes: 0 }
}

function categoryOf(path: string): StateCategory {
	const top = path.split('/')[0] ?? path
	const name = basename(path)
	if (name.endsWith('.lock') || name.includes('.tmp.') || name.endsWith('.candidate')) {
		return 'transient'
	}
	if (AUTHORED_TOP_LEVEL.has(top)) return 'authored'
	if (CONFIG_TOP_LEVEL.has(top)) return 'configuration'
	if (RUNTIME_TOP_LEVEL.has(top)) return 'runtime'
	if (CONTROL_TOP_LEVEL.has(top)) return 'control'
	return 'unknown'
}

async function inventoryOf(collection: RootCollection, sink: IssueSink): Promise<StateInventory> {
	const files = new Map(
		collection.entries
			.filter((entry): entry is Entry & { kind: 'file' } => entry.kind === 'file')
			.map((entry) => [entry.relative, entry]),
	)
	const directories = collection.entries.filter((entry) => entry.kind === 'directory')
	const sessionDirs = directories.filter((entry) => isCanonicalSessionDir(entry.relative))
	const runDirs = directories.filter((entry) => isCanonicalRunDir(entry.relative))

	const validSessions = new Map<string, Entry>()
	let candidateAnalysisComplete = true
	for (const directory of sessionDirs) {
		const record = files.get(`${directory.relative}/session.json`)
		if (!record) continue
		const parsed = await readJsonRecord(record, sink)
		const expected = basename(directory.relative)
		if (recordId(parsed) === expected) validSessions.set(expected, directory)
		else candidateAnalysisComplete = false
	}

	const validRuns: Entry[] = []
	for (const directory of runDirs) {
		const record = files.get(`${directory.relative}/run.json`)
		if (!record) continue
		const parsed = await readJsonRecord(record, sink)
		if (recordId(parsed) === basename(directory.relative)) validRuns.push(directory)
	}

	const checkpointFiles = [...files.values()].filter((entry) =>
		isCanonicalCheckpointFile(entry.relative),
	)
	const emergencyFiles = [...files.values()].filter((entry) =>
		isCanonicalEmergencyFile(entry.relative),
	)
	const attachmentFiles = [...files.values()].filter((entry) =>
		entry.relative.startsWith('attachments/'),
	)
	const attachmentKeys = new Map<string, { data?: Entry; type?: Entry }>()
	for (const entry of attachmentFiles) {
		const suffix = entry.relative.endsWith('.bin')
			? '.bin'
			: entry.relative.endsWith('.type')
				? '.type'
				: undefined
		if (!suffix) continue
		const key = entry.relative.slice('attachments/'.length, -suffix.length)
		const pair = attachmentKeys.get(key) ?? {}
		if (suffix === '.bin') pair.data = entry
		else pair.type = entry
		attachmentKeys.set(key, pair)
	}

	const candidates = await originOnlyCandidates(files, validSessions, runDirs, sink)
	candidateAnalysisComplete &&= candidates.complete

	return {
		sessions: {
			...measureDirectories(validSessions.values(), collection.entries),
			directories: sessionDirs.length,
			invalidOrMissingRecords: sessionDirs.length - validSessions.size,
		},
		originOnlySessionCandidates: {
			...measureDirectories(candidates.directories, collection.entries),
			complete: candidateAnalysisComplete,
			limitation:
				'Candidates have only a new-conversation origin, no messages, runs, goal, title, desktop mapping, fork reference, or sub-session link. They are not declared safe to delete because no writer lease was acquired.',
		},
		runs: {
			...measureDirectories(validRuns, collection.entries),
			directories: runDirs.length,
			invalidOrMissingRecords: runDirs.length - validRuns.length,
		},
		checkpointFiles: measureFiles(checkpointFiles),
		emergencyDumpFiles: measureFiles(emergencyFiles),
		attachments: {
			...measureFiles(attachmentFiles),
			pairs: [...attachmentKeys.values()].filter((pair) => pair.data && pair.type).length,
			orphanedDataFiles: [...attachmentKeys.values()].filter((pair) => pair.data && !pair.type)
				.length,
			orphanedTypeFiles: [...attachmentKeys.values()].filter((pair) => pair.type && !pair.data)
				.length,
		},
	}
}

function isCanonicalSessionDir(path: string): boolean {
	return /^projects\/prj_[^/]+\/sessions\/ses_[^/]+$/u.test(path)
}

function isCanonicalRunDir(path: string): boolean {
	return (
		/^projects\/prj_[^/]+\/sessions\/ses_[^/]+\/runs\/run_[^/]+$/u.test(path) ||
		/^projects\/prj_[^/]+\/sessions\/ses_[^/]+\/runs\/run_[^/]+\/children\/run_[^/]+$/u.test(path)
	)
}

function isCanonicalCheckpointFile(path: string): boolean {
	return (
		/^projects\/prj_[^/]+\/sessions\/ses_[^/]+\/runs\/run_[^/]+\/checkpoints\/cp_[^/]+\.json$/u.test(
			path,
		) ||
		/^projects\/prj_[^/]+\/sessions\/ses_[^/]+\/runs\/run_[^/]+\/children\/run_[^/]+\/checkpoints\/cp_[^/]+\.json$/u.test(
			path,
		)
	)
}

function isCanonicalEmergencyFile(path: string): boolean {
	return /^projects\/prj_[^/]+\/sessions\/ses_[^/]+\/runs\/emergency\/run_[^/]+\.json$/u.test(path)
}

async function originOnlyCandidates(
	files: ReadonlyMap<string, Entry>,
	sessions: ReadonlyMap<string, Entry>,
	runDirs: readonly Entry[],
	sink: IssueSink,
): Promise<{
	readonly complete: boolean
	readonly directories: readonly Entry[]
}> {
	let complete = true
	const referenced = new Set<string>()
	const originKinds = new Map<string, string>()
	for (const [sessionId, directory] of sessions) {
		const evidence = files.get(`${directory.relative}/turns.jsonl`)
		if (!evidence) continue
		if (evidence.size > MAX_ORIGIN_BYTES) {
			complete = false
			pushIssue(sink, {
				code: 'inspection_skipped',
				path: evidence.relative,
				detail: `Turn evidence exceeds the ${MAX_ORIGIN_BYTES}-byte origin-inspection cap; its raw bytes remain counted.`,
			})
			continue
		}
		try {
			const raw = await readBoundedRegularFile(evidence, MAX_ORIGIN_BYTES)
			const lines = raw.split('\n').filter((line) => line.length > 0)
			if (lines.length !== 1) continue
			const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>
			if (parsed.type !== 'conversation_started' || parsed.sessionId !== sessionId) continue
			const origin = parsed.origin
			if (typeof origin !== 'object' || origin === null) continue
			const originRecord = origin as Record<string, unknown>
			if (typeof originRecord.kind === 'string') originKinds.set(sessionId, originRecord.kind)
			if (typeof originRecord.sourceSessionId === 'string') {
				referenced.add(originRecord.sourceSessionId)
			}
		} catch (error) {
			complete = false
			metadataIssue(sink, evidence.relative, error)
		}
	}

	const titles = await readStringKeys(files.get('titles.json'), sink)
	const desktopTargets = await readStringValues(files.get('desktop-sessions.json'), sink)
	if (titles === null || desktopTargets === null) complete = false
	for (const id of titles ?? []) referenced.add(id)
	for (const id of desktopTargets ?? []) referenced.add(id)

	for (const entry of files.values()) {
		if (!entry.relative.endsWith('/subsession.json')) continue
		const parsed = await readJsonRecord(entry, sink)
		if (!parsed) {
			complete = false
			continue
		}
		for (const key of ['parentSessionId', 'childSessionId'] as const) {
			const id = parsed[key]
			if (typeof id === 'string') referenced.add(id)
		}
	}

	if (!complete) return { complete: false, directories: [] }
	const candidates: Entry[] = []
	for (const [sessionId, directory] of sessions) {
		if (originKinds.get(sessionId) !== 'new' || referenced.has(sessionId)) continue
		const messages = files.get(`${directory.relative}/messages.jsonl`)
		if (messages && messages.size > 0) continue
		if (runDirs.some((run) => run.relative.startsWith(`${directory.relative}/runs/`))) continue
		if (files.has(`goals/${sessionId}.json`)) continue
		candidates.push(directory)
	}
	return { complete: true, directories: candidates }
}

async function readStringKeys(entry: Entry | undefined, sink: IssueSink): Promise<string[] | null> {
	if (!entry) return []
	const parsed = await readJsonRecord(entry, sink)
	if (!parsed) return null
	return Object.keys(parsed)
}

async function readStringValues(
	entry: Entry | undefined,
	sink: IssueSink,
): Promise<string[] | null> {
	if (!entry) return []
	const parsed = await readJsonRecord(entry, sink)
	if (!parsed) return null
	return Object.values(parsed).filter((value): value is string => typeof value === 'string')
}

function measureFiles(entries: readonly Entry[]): StateMeasure {
	return {
		files: entries.length,
		logicalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
	}
}

function measureDirectories(directories: Iterable<Entry>, entries: readonly Entry[]): StateMeasure {
	const selected = [...directories]
	let logicalBytes = 0
	for (const directory of selected) {
		const prefix = `${directory.relative}/`
		logicalBytes += entries
			.filter((entry) => entry.kind === 'file' && entry.relative.startsWith(prefix))
			.reduce((sum, entry) => sum + entry.size, 0)
	}
	return { files: selected.length, logicalBytes }
}

function privacyOf(
	collection: RootCollection,
	context: { readonly platform: NodeJS.Platform; readonly uid?: number },
	sink: IssueSink,
): StatePrivacyBoundary[] {
	const byRelative = new Map(collection.entries.map((entry) => [entry.relative, entry]))
	const out: StatePrivacyBoundary[] = []
	for (const segment of PRIVATE_BOUNDARIES) {
		const entry = byRelative.get(segment)
		if (!entry) continue
		if (entry.kind !== 'directory') {
			out.push({
				path: segment,
				status: 'insecure',
				detail: 'Boundary is not a directory.',
			})
			continue
		}
		if (context.platform === 'win32' || context.uid === undefined) {
			out.push({
				path: segment,
				status: 'unknown',
				detail: 'POSIX mode bits cannot establish the effective owner-only ACL on this platform.',
			})
			continue
		}
		const root = collection.rootEntry
		const rootOwnerMatches =
			root?.uid === undefined || context.uid === undefined || root.uid === context.uid
		const rootIsPrivate =
			root?.kind === 'directory' && rootOwnerMatches && (root.mode & 0o077) === 0
		if (entry.uid !== undefined && entry.uid !== context.uid) {
			pushIssue(sink, {
				code: 'owner_mismatch',
				path: segment,
				detail: `Boundary is owned by uid ${entry.uid}, current uid is ${context.uid}.`,
			})
			out.push({
				path: segment,
				status: 'insecure',
				detail: 'Boundary owner does not match.',
			})
			continue
		}
		const exposed = entry.mode & 0o077
		out.push(
			exposed === 0 || rootIsPrivate
				? {
						path: segment,
						status: 'secure',
						detail:
							exposed === 0
								? 'Owner-only directory boundary.'
								: 'Shared child mode is contained by the owner-only state root.',
					}
				: {
						path: segment,
						status: 'insecure',
						detail: `Directory mode ${modeText(entry.mode)} grants group or other access.`,
					},
		)
	}
	return out
}

function modeText(mode: number): string {
	return (mode & 0o777).toString(8).padStart(3, '0')
}

async function inspectProjectBinding(
	collection: RootCollection,
	canonicalCwd: string,
): Promise<ProjectBinding> {
	if (!collection.exists) {
		return {
			status: 'uninitialized',
			detail: 'No project-local runtime state exists.',
		}
	}
	const files = new Map(
		collection.entries
			.filter((entry): entry is Entry & { kind: 'file' } => entry.kind === 'file')
			.map((entry) => [entry.relative, entry]),
	)
	const pointer = files.get('cli.json')
	if (!pointer) {
		const hasProjects = collection.entries.some((entry) => entry.relative.startsWith('projects/'))
		return hasProjects
			? {
					status: 'missing-pointer',
					detail: 'Runtime projects exist but cli.json does not select one.',
				}
			: { status: 'uninitialized', detail: 'No CLI project pointer exists.' }
	}
	let parsed: Record<string, unknown>
	try {
		const value = JSON.parse(await readBoundedRegularFile(pointer, MAX_METADATA_BYTES)) as unknown
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			return {
				status: 'invalid-pointer',
				detail: 'cli.json is not an object.',
			}
		}
		parsed = value as Record<string, unknown>
	} catch (error) {
		return {
			status: 'invalid-pointer',
			detail: `cli.json could not be read as bounded JSON: ${errorMessage(error)}`,
		}
	}
	const projectId = parsed.projectId
	if (typeof projectId !== 'string' || !/^prj_[A-Za-z0-9_-]+$/u.test(projectId)) {
		return {
			status: 'invalid-pointer',
			detail: 'cli.json has no valid projectId.',
		}
	}
	const project = files.get(`projects/${projectId}/project.json`)
	if (!project) {
		return {
			status: 'missing-project',
			projectId,
			detail: 'cli.json selects a project record that is not present.',
		}
	}
	let record: Record<string, unknown>
	try {
		const value = JSON.parse(await readBoundedRegularFile(project, MAX_METADATA_BYTES)) as unknown
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			return {
				status: 'corrupt-project',
				projectId,
				detail: 'project.json is not an object.',
			}
		}
		record = value as Record<string, unknown>
	} catch (error) {
		return {
			status: 'corrupt-project',
			projectId,
			detail: `project.json could not be read as bounded JSON: ${errorMessage(error)}`,
		}
	}
	if (record.id !== projectId) {
		return {
			status: 'corrupt-project',
			projectId,
			detail: 'project.json id does not match the selected directory.',
		}
	}
	if (typeof record.rootPath !== 'string' || record.rootPath.length === 0) {
		return {
			status: 'legacy-unbound',
			projectId,
			detail: 'Project record predates canonical root binding; cli.json is its only locator.',
		}
	}
	if (!isAbsolute(record.rootPath)) {
		return {
			status: 'corrupt-project',
			projectId,
			detail: 'project.json rootPath is not absolute.',
		}
	}
	const recordedRoot = await canonicalBase(record.rootPath)
	if (recordedRoot !== canonicalCwd) {
		return {
			status: 'root-mismatch',
			projectId,
			recordedRoot,
			detail: 'Project record is bound to a different canonical working directory.',
		}
	}
	return {
		status: 'bound',
		projectId,
		detail: 'Project id and canonical root agree.',
	}
}

async function readJsonRecord(
	entry: Entry,
	sink: IssueSink,
): Promise<Record<string, unknown> | null> {
	if (entry.size > MAX_METADATA_BYTES) {
		pushIssue(sink, {
			code: 'inspection_skipped',
			path: entry.relative,
			detail: `Metadata exceeds the ${MAX_METADATA_BYTES}-byte semantic-inspection cap; its raw bytes remain counted.`,
		})
		return null
	}
	try {
		const value = JSON.parse(await readBoundedRegularFile(entry, MAX_METADATA_BYTES)) as unknown
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			throw new Error('expected a JSON object')
		}
		return value as Record<string, unknown>
	} catch (error) {
		metadataIssue(sink, entry.relative, error)
		return null
	}
}

function recordId(value: Record<string, unknown> | null): string | undefined {
	return typeof value?.id === 'string' ? value.id : undefined
}

function metadataIssue(sink: IssueSink, path: string, error: unknown): void {
	pushIssue(sink, {
		code: error instanceof EntryChangedError ? 'entry_changed' : 'corrupt_metadata',
		path,
		detail: errorMessage(error),
	})
}

async function readBoundedRegularFile(entry: Entry, maxBytes: number): Promise<string> {
	if (entry.kind !== 'file') throw new Error('entry is not a regular file')
	if (entry.size > maxBytes) throw new Error(`metadata exceeds ${maxBytes} bytes`)
	const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)
	const handle = await open(entry.absolute, constants.O_RDONLY | noFollow)
	try {
		const before = await handle.stat()
		assertSameEntry(entry, before)
		if (before.size > maxBytes) throw new Error(`metadata exceeds ${maxBytes} bytes`)
		const contents = await handle.readFile({ encoding: 'utf8' })
		const after = await handle.stat()
		if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
			throw new EntryChangedError('entry changed while its contents were being read')
		}
		return contents
	} finally {
		await handle.close()
	}
}

function assertSameEntry(entry: Entry, stat: Stats): void {
	if (!stat.isFile()) throw new EntryChangedError('entry is no longer a regular file')
	if (
		stat.dev !== entry.device ||
		stat.ino !== entry.inode ||
		stat.size !== entry.size ||
		stat.mtimeMs !== entry.modifiedAt
	) {
		throw new EntryChangedError('entry changed after filesystem enumeration')
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
