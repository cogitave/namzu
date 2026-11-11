import { isAbsolute, join as joinPath, posix, relative, sep } from 'node:path'

import { subscribeToAbort } from '../../utils/abort.js'

/**
 * How long grep and glob search before they return what they have. The tool
 * deadline (15 s) cancels a call outright and discards its output; a search
 * that ends itself a little earlier can still hand back its matches.
 */
export const SEARCH_BUDGET_MS = 12_000

/** Matching files a search reads at most; past it the search ends with what it has. */
export const MAX_FILES_SEARCHED = 50_000

export interface SearchBudget {
	/** Fires when the caller cancels or the budget runs out. */
	readonly signal: AbortSignal
	/** True only when the budget ran out, not when the caller cancelled. */
	expired(): boolean
	close(): void
}

/** A signal that follows `parent` and also fires when the search budget is spent. */
export function openSearchBudget(parent?: AbortSignal, budgetMs = SEARCH_BUDGET_MS): SearchBudget {
	const controller = new AbortController()
	let spent = false
	const stopWatching = parent
		? subscribeToAbort(parent, () => controller.abort(parent.reason))
		: undefined
	const timer = setTimeout(() => {
		spent = true
		controller.abort(new Error('search budget spent'))
	}, budgetMs)
	return {
		signal: controller.signal,
		expired: () => spent && !parent?.aborted,
		close() {
			clearTimeout(timer)
			stopWatching?.()
		},
	}
}

/**
 * A file as the model sees it: relative to the working directory when it lies
 * under it, otherwise absolute. Never prefixed with `./`.
 */
export function hostDisplayPath(workingDirectory: string, absolute: string): string {
	const rel = relative(workingDirectory, absolute)
	if (rel === '') return '.'
	if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return absolute
	return sep === '/' ? rel : rel.split(sep).join('/')
}

/** Keep unusual filenames unambiguous without changing the returned path data. */
export function quoteControlPath(path: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: quote filenames containing control bytes instead of creating fake result lines.
	return /[\x00-\x1f\x7f]/.test(path) ? JSON.stringify(path) : path
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

/** The line that tells the model why a search stopped before it finished. */
export function stoppedNotice(reason: 'time' | 'entries' | 'files', visited?: number): string {
	const how =
		reason === 'time'
			? `after ${SEARCH_BUDGET_MS / 1000} seconds`
			: reason === 'entries'
				? `after examining ${(visited ?? 0).toLocaleString('en-US')} entries`
				: `after reading ${MAX_FILES_SEARCHED.toLocaleString('en-US')} files`
	return `[Search stopped early ${how}. Results may be incomplete; narrow the path or pattern, or add an ignore rule.]`
}

/** Tells the model that an empty result may hide files an ignore rule excluded. */
export function ignoredHint(ignoredDirectories: number): string {
	return `(${plural(ignoredDirectories, 'ignored directory', 'ignored directories')} skipped by ignore rules; pass include_ignored: true to search ${ignoredDirectories === 1 ? 'it' : 'them'}.)`
}

/** A walker written before the entry bound became a normal stop still throws this. */
export function isEntryLimit(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === 'ERR_FILE_WALK_LIMIT'
}

/**
 * Whether the session's read rules deny this file, so a search neither lists
 * nor opens it. `path` is absolute: a host path, or, when `sandboxRoot` is
 * given, a path inside the sandbox, which is mapped to the same place under
 * the working directory because that is the folder the sandbox binds; a path
 * outside that folder is denied. A host
 * that supplies no rules (`ToolContext.readDenied` absent) denies nothing.
 */
export function isReadDenied(
	context: { workingDirectory: string; readDenied?: (path: string) => boolean },
	path: string,
	sandboxRoot?: string,
): boolean {
	if (!context.readDenied) return false
	if (sandboxRoot === undefined) return context.readDenied(path)
	const relative = posix.relative(sandboxRoot, path)
	// A guest path outside the bound folder has no host counterpart the rules
	// could be checked against, so a session that has read rules does not list
	// or open it.
	if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) return true
	return context.readDenied(joinPath(context.workingDirectory, relative))
}

/**
 * Pulls from `source` ahead of the consumer, up to `ahead` items, so a walk's
 * directory reads overlap with the matching of files already listed. Order is
 * unchanged. An error from the source is thrown to the consumer after the
 * items listed before it; when the consumer stops, the source is closed (its
 * own cleanup runs) before this returns.
 */
export async function* readAhead<T>(source: AsyncIterable<T>, ahead = 256): AsyncGenerator<T> {
	const iterator = source[Symbol.asyncIterator]()
	const buffer: T[] = []
	let finished = false
	let failure: { error: unknown } | undefined
	let stop = false
	let wakeConsumer: (() => void) | undefined
	let wakeProducer: (() => void) | undefined
	const notifyConsumer = () => {
		const wake = wakeConsumer
		wakeConsumer = undefined
		wake?.()
	}
	const producer = (async () => {
		try {
			while (!stop) {
				if (buffer.length >= ahead) {
					await new Promise<void>((resolve) => {
						wakeProducer = resolve
					})
					continue
				}
				const next = await iterator.next()
				if (next.done) break
				buffer.push(next.value)
				notifyConsumer()
			}
		} catch (error) {
			failure = { error }
		}
		finished = true
		notifyConsumer()
	})()
	try {
		for (;;) {
			if (buffer.length > 0) {
				const item = buffer.shift() as T
				wakeProducer?.()
				yield item
				continue
			}
			if (failure) throw failure.error
			if (finished) return
			await new Promise<void>((resolve) => {
				wakeConsumer = resolve
			})
		}
	} finally {
		stop = true
		wakeProducer?.()
		await producer
		await iterator.return?.()
	}
}
