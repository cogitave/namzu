import { isAbsolute, posix } from 'node:path'
import braceExpansion from 'brace-expansion'
import { GLOBSTAR, Minimatch } from 'minimatch'
import type {
	SandboxExecOptions,
	SandboxExecResult,
	SandboxFileEntry,
	SandboxWalkFilesOptions,
} from '../types/sandbox/index.js'
import { subscribeToAbort } from '../utils/abort.js'
import { FILE_WALK_PROGRAM } from './file-walk-program.js'

interface WalkPlan {
	root: string
	prefix: string[]
	expressions: { source: string; flags: string }[]
	maxDepth: number | null
	maxEntries: number
	maxVisitedEntries: number
	includeHidden: boolean
	patterns: (string | { source: string; flags: string } | null)[][]
}

// brace-expansion 2.1.4 implements these bounds; its older DefinitelyTyped
// declaration only describes the first argument.
const expandBraces = braceExpansion as (
	pattern: string,
	options: { max: number; maxLength: number },
) => string[]

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer`)
	}
	return value
}

function planWalk(root: string, options: SandboxWalkFilesOptions): WalkPlan {
	if (!isAbsolute(root) && !posix.isAbsolute(root)) {
		throw new Error('File walk root must be an absolute path')
	}
	let pattern = options.pattern ?? '**/*'
	while (pattern.startsWith('./')) pattern = pattern.slice(2)
	if (
		!pattern ||
		pattern.startsWith('/') ||
		/^[a-z]:/i.test(pattern) ||
		pattern.split('/').includes('..')
	) {
		throw new Error('File walk pattern must be relative to its root and cannot contain ..')
	}
	if (pattern.length > 4096) throw new RangeError('File walk pattern exceeds 4096 characters')
	// Expansion cannot lengthen a branch beyond its source. Bound both source
	// length and branch count, then disable the library's separate character cap:
	// that cap can silently truncate before our extra branch proves incompleteness.
	const branches = expandBraces(pattern, { max: 257, maxLength: Number.POSITIVE_INFINITY })
	if (branches.length > 256) throw new RangeError('File walk pattern exceeds 256 brace expansions')
	const matchers = branches.map((branch) => {
		if (branch.startsWith('/') || /^[a-z]:/i.test(branch) || branch.split('/').includes('..')) {
			throw new Error('Expanded file walk pattern escapes its root')
		}
		return new Minimatch(branch, {
			nobrace: true,
			nonegate: true,
			nocomment: true,
			dot: options.includeHidden ?? false,
			platform: 'linux',
		})
	})
	const sets = matchers.flatMap((matcher) => matcher.set)
	if (sets.some((set) => set.some((segment) => segment === '..'))) {
		throw new Error('Expanded file walk pattern escapes its root')
	}
	const patternDepth = Math.max(
		1,
		...sets.map((set) => (set.includes(GLOBSTAR) ? Number.POSITIVE_INFINITY : set.length)),
	)
	const maxDepth = Math.min(
		patternDepth,
		options.maxDepth === undefined
			? Number.POSITIVE_INFINITY
			: positiveInteger(options.maxDepth, 'maxDepth'),
	)
	const prefix: string[] = []
	for (let index = 0; sets.length > 0; index += 1) {
		const segment = sets[0]?.[index]
		if (
			typeof segment !== 'string' ||
			!segment ||
			segment === '.' ||
			sets.some((set) => index >= set.length - 1 || set[index] !== segment)
		)
			break
		prefix.push(segment)
	}
	const expressions = matchers.flatMap((matcher) => {
		const expression = matcher.makeRe()
		return expression ? [{ source: expression.source, flags: expression.flags }] : []
	})
	return {
		root,
		prefix,
		expressions,
		maxDepth: Number.isFinite(maxDepth) ? maxDepth : null,
		maxEntries: positiveInteger(options.maxEntries, 'maxEntries'),
		maxVisitedEntries: positiveInteger(options.maxVisitedEntries ?? 20_000, 'maxVisitedEntries'),
		includeHidden: options.includeHidden ?? false,
		patterns: sets.map((set) =>
			set.map((segment) =>
				segment === GLOBSTAR
					? null
					: typeof segment === 'string'
						? segment
						: { source: segment.source, flags: segment.flags },
			),
		),
	}
}

/** Whether at least one parsed pattern can match a file below this directory. */
function directoryMatcher(plan: WalkPlan): (relative: string) => boolean {
	const patterns = plan.patterns.map((set) =>
		set.map((part) =>
			typeof part === 'object' && part !== null ? new RegExp(part.source, `${part.flags}s`) : part,
		),
	)
	return (relative) =>
		patterns.some((pattern) => {
			const closure = (states: Set<number>) => {
				for (const index of states) if (pattern[index] === null) states.add(index + 1)
				return states
			}
			let states = closure(new Set([0]))
			for (const name of relative.split('/')) {
				const next = new Set<number>()
				for (const index of states) {
					const segment = pattern[index]
					if (segment === null) {
						if (plan.includeHidden || !name.startsWith('.')) next.add(index)
					} else if (typeof segment === 'string' ? segment === name : segment?.test(name))
						next.add(index + 1)
				}
				states = closure(next)
				if (states.size === 0) return false
			}
			return [...states].some((index) => index < pattern.length)
		})
}

/** Local traversal uses the same compiled matching/pruning plan as the guest. */
async function* executeWalk(
	plan: WalkPlan,
	signal?: AbortSignal,
): AsyncGenerator<SandboxFileEntry> {
	const fs = await import('node:fs/promises')
	const path = await import('node:path')
	const { EventEmitter } = await import('node:events')
	const open: { dir: import('node:fs').Dir; relative: string; depth: number }[] = []
	let visited = 0
	let emitted = 0
	const matchers = plan.expressions.map(({ source, flags }) => new RegExp(source, `${flags}s`))
	const canDescend = directoryMatcher(plan)
	const maxDepth = plan.maxDepth ?? Number.POSITIVE_INFINITY
	const missing = (error: unknown) =>
		['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
	const close = async (dir: import('node:fs').Dir) => {
		try {
			await dir.close()
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') throw error
		}
	}
	const check = () => signal?.throwIfAborted()
	async function wait<T>(pending: Promise<T>, late?: (value: T) => void): Promise<T> {
		if (!signal) return await pending
		let abandoned = signal.aborted
		let dispose: (() => void) | undefined
		const observed = pending.then((value) => {
			if (abandoned) late?.(value)
			return value
		})
		try {
			return await Promise.race([
				observed,
				new Promise<never>((_, reject) => {
					const abort = () => {
						abandoned = true
						reject(signal.reason)
					}
					if (signal.aborted) {
						abort()
						return
					}
					if (typeof EventEmitter.addAbortListener === 'function') {
						const subscription = EventEmitter.addAbortListener(signal, abort)
						dispose = () => subscription[Symbol.dispose]()
					} else {
						signal.addEventListener('abort', abort, { once: true })
						dispose = () => signal.removeEventListener('abort', abort)
					}
				}),
			])
		} finally {
			dispose?.()
		}
	}
	const noteVisit = () => {
		visited += 1
		if (visited > plan.maxVisitedEntries) {
			throw Object.assign(
				new Error(
					`File search stopped after examining ${plan.maxVisitedEntries} entries; narrow its root or pattern.`,
				),
				{ code: 'ERR_FILE_WALK_LIMIT' },
			)
		}
	}
	try {
		check()
		if (plan.patterns.length === 0) return
		let canonicalRoot: string
		try {
			canonicalRoot = await wait(fs.realpath(plan.root))
		} catch (error) {
			if (missing(error)) return
			throw error
		}
		if (canonicalRoot !== path.resolve(plan.root))
			throw new Error('File walk root follows a symbolic link; use its authorized real directory')
		let start = plan.root
		// Never follow a static-prefix symlink to speed up a pattern: traversal
		// and its optimized starting point must have the same link policy.
		for (const part of plan.prefix) {
			check()
			start = path.join(start, part)
			let info: import('node:fs').Stats
			try {
				info = await wait(fs.lstat(start))
			} catch (error) {
				if (missing(error)) return
				throw error
			}
			noteVisit()
			if (!info.isDirectory()) return
		}
		if (plan.prefix.length >= maxDepth) return
		const openDirectory = async (absolute: string, relative: string, depth: number) => {
			check()
			try {
				const dir = await wait(fs.opendir(absolute), (late) => {
					void close(late).catch(() => {})
				})
				open.push({ dir, relative, depth })
			} catch (error) {
				if (!missing(error)) throw error
			}
		}
		await openDirectory(start, plan.prefix.join('/'), plan.prefix.length)
		while (open.length > 0) {
			check()
			const frame = open[open.length - 1] as (typeof open)[number]
			const entry = await wait(frame.dir.read())
			check()
			if (!entry) {
				open.pop()
				await close(frame.dir)
				continue
			}
			noteVisit()
			const relative = frame.relative ? `${frame.relative}/${entry.name}` : entry.name
			const absolute = path.join(plan.root, relative)
			const depth = frame.depth + 1
			if (entry.isDirectory()) {
				if (depth < maxDepth && canDescend(relative)) await openDirectory(absolute, relative, depth)
				continue
			}
			if (!entry.isFile() || !matchers.some((matcher) => matcher.test(relative))) continue
			let info: import('node:fs').Stats
			try {
				info = await wait(fs.lstat(absolute))
			} catch (error) {
				if (missing(error)) continue
				throw error
			}
			check()
			if (!info.isFile()) continue
			emitted += 1
			yield { path: absolute, size: info.size }
			if (emitted >= plan.maxEntries) return
		}
	} finally {
		for (const { dir } of open.reverse()) {
			if (signal?.aborted) {
				void close(dir).catch(() => {})
			} else await close(dir)
		}
	}
}

/** Internal host path; the caller first resolves its authorized filesystem root. */
export async function* walkFilesLocally(
	rootPath: string,
	options: SandboxWalkFilesOptions,
): AsyncGenerator<SandboxFileEntry> {
	options.signal?.throwIfAborted()
	yield* executeWalk(planWalk(rootPath, options), options.signal)
}

/** The existing sandbox execution seam; no separate worker protocol is needed. */
export type SandboxFileWalkExec = (
	command: string,
	argv?: string[],
	options?: SandboxExecOptions,
) => Promise<SandboxExecResult>

/**
 * Lazy, bounded JSONL enumeration inside the execution boundary owned by exec.
 * The adapter must implement SandboxExecOptions.signal: iterator cleanup waits
 * for cancellation settlement and preserves failures to confirm remote shutdown.
 */
export async function* walkFilesViaExec(
	exec: SandboxFileWalkExec,
	rootPath: string,
	options: SandboxWalkFilesOptions,
): AsyncGenerator<SandboxFileEntry> {
	options.signal?.throwIfAborted()
	const plan = planWalk(rootPath, options)
	const controller = new AbortController()
	const dispose = options.signal
		? subscribeToAbort(options.signal, () => controller.abort(options.signal?.reason))
		: undefined
	const queue: SandboxFileEntry[] = []
	let wake: (() => void) | undefined
	let buffered = ''
	let observedOutput = false
	let settled = false
	let terminal = false
	let received = 0
	let failure: unknown
	const reject = (error: unknown) => {
		failure ??= error instanceof Error ? error : new Error(String(error))
		controller.abort(error)
		wake?.()
	}
	const consume = (line: string) => {
		if (line.length > 65_536) throw new Error('File walk record exceeded its output bound')
		const value: unknown = JSON.parse(line)
		if (!value || typeof value !== 'object' || terminal) throw new Error('Invalid file walk record')
		const record = value as Record<string, unknown>
		if (record.type === 'done') {
			terminal = true
			return
		}
		if (record.type === 'error' && typeof record.message === 'string') {
			terminal = true
			throw Object.assign(new Error(record.message), {
				code: typeof record.code === 'string' ? record.code : undefined,
			})
		}
		if (
			record.type !== 'entry' ||
			typeof record.path !== 'string' ||
			typeof record.size !== 'number' ||
			!Number.isSafeInteger(record.size) ||
			record.size < 0
		) {
			throw new Error('Invalid file walk entry')
		}
		const relative = posix.relative(rootPath, record.path)
		if (
			!posix.isAbsolute(record.path) ||
			relative === '..' ||
			relative.startsWith('../') ||
			posix.isAbsolute(relative)
		) {
			throw new Error('File walk entry escaped its requested root')
		}
		if (++received > plan.maxEntries) throw new Error('File walk exceeded its entry bound')
		queue.push({ path: record.path, size: record.size })
	}
	const ingest = (data: string) => {
		try {
			let start = 0
			for (;;) {
				const newline = data.indexOf('\n', start)
				const end = newline < 0 ? data.length : newline
				if (buffered.length + end - start > 65_536)
					throw new Error('File walk record exceeded its output bound')
				buffered += data.slice(start, end)
				if (newline < 0) break
				consume(buffered)
				buffered = ''
				start = newline + 1
			}
		} catch (error) {
			reject(error)
		}
		wake?.()
	}
	const pending = Promise.resolve()
		.then(() => {
			controller.signal.throwIfAborted()
			return exec('node', ['-e', FILE_WALK_PROGRAM, JSON.stringify(plan)], {
				signal: controller.signal,
				onOutput: ({ stream, data }) => {
					if (stream === 'stdout') {
						observedOutput = true
						ingest(data)
					}
				},
			})
		})
		.then(
			(result) => {
				if (controller.signal.aborted) return
				if (!observedOutput && result.stdout) ingest(result.stdout)
				if (buffered) reject(new Error('File walk ended with an incomplete record'))
				if (result.stdoutTruncated || result.stderrTruncated)
					reject(new Error('File walk transport truncated its output'))
				if (result.timedOut || result.exitCode !== 0)
					reject(
						new Error(
							result.timedOut
								? 'File walk timed out'
								: `File walk failed with exit code ${result.exitCode}: ${result.stderr}`,
						),
					)
				if (!terminal && !controller.signal.aborted)
					reject(new Error('File walk ended without its completion record'))
			},
			(error) => {
				reject(error)
			},
		)
		.finally(() => {
			settled = true
			wake?.()
		})
	try {
		for (;;) {
			options.signal?.throwIfAborted()
			const entry = queue.shift()
			if (entry) {
				yield entry
				continue
			}
			if (failure) throw failure
			if (settled) break
			await new Promise<void>((resolve) => {
				wake = resolve
			})
			wake = undefined
		}
	} finally {
		dispose?.()
		if (!settled) controller.abort(new Error('File walk consumer stopped'))
		await pending
		// A rejected cancellation can mean remote work is still alive. Preserve
		// that error so the owning backend can retire the uncertain handle.
		// biome-ignore lint/correctness/noUnsafeFinally: a failed remote cleanup must also reject iterator.return().
		if (failure) throw failure
	}
}
